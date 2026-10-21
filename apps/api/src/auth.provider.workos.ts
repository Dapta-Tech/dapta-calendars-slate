/**
 * The concrete host AuthProvider for `AUTH_PROVIDER=workos`.
 *
 * It does NOT talk to WorkOS. Login (hosted AuthKit, social providers) lives in
 * the upstream identity service, which after login mints an HS256 platform JWT
 * (shared secret; claims `sub`, `account_id`, `email`, `name`, and
 * `workos_user_id` when the login came through WorkOS). This provider is the
 * DOWNSTREAM validator only: it verifies that token and projects its claims
 * onto a local `{accountId, memberId}`, recording `workos_user_id` on the
 * member (`member.idp_subject`) so an MCP sign-in through the same identity can
 * find it. This is the exact split the predecessor service used, and it is
 * what makes local and remote behave identically: the secret is symmetric, so
 * there is nothing environment-specific to fetch.
 *
 * Because it only ever *validates* tokens (never issues them, never calls the
 * identity service or WorkOS), it cannot affect the upstream login in any way —
 * a bad/absent secret here fails logins to THIS service only.
 *
 * NOTE (OSS surface): kept in-repo for the internal-first phase. Before the
 * public flip it moves to the private overlay behind the same seam; the public
 * `createAuthProvider` still fails loud without it. No vendor host/secret name
 * appears here — issuer/audience/secret all arrive via env.
 */
import { Logger, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Db, AccountRole } from '@slate/db';
import { deriveUniqueHandle, insertAccountWithShortCode, jsonParam, recordMemberIdpSubject, sql } from '@slate/db';
import { withNewHostBranding } from '@slate/shared';
import type { ServerEnv } from '@slate/config/env';
import {
  header,
  notifySignup,
  type AuthProvider,
  type ResolvedHost,
  type ReqLike,
  type SignupObserver,
} from './auth.provider';
import { verifyJwtHs256, JwtError, type JwtClaims } from './jwt';

type WorkOsEnv = Pick<ServerEnv, 'JWT_SECRET' | 'JWT_ISSUER' | 'JWT_AUDIENCE' | 'OPERATOR_EMAIL_DOMAIN'>;

/**
 * The address this token vouches for, lowercased, or null: none in the token,
 * or one the identity service marks unverified (`email_verified: false`). It is
 * what finds the person's invitations in other accounts, so an address the
 * identity service has not verified must never claim one.
 */
function vouchedEmail(claims: JwtClaims): string | null {
  if (claims.email_verified === false) return null;
  return typeof claims.email === 'string' ? claims.email.trim().toLowerCase() || null : null;
}

function unauthenticated(message: string): UnauthorizedException {
  return new UnauthorizedException({ error: 'UNAUTHENTICATED', message });
}

// Account codes are 6-char short codes from @slate/db (generateUniqueShortCode)
// — the old `acct-<hex>` derivation leaked machine garbage into every public
// URL. Idempotency across concurrent first-logins is anchored on external_id
// (ON CONFLICT), so the code no longer needs to be deterministic.

/** A resolved member and the authorization-server subject it carries now. */
interface ResolvedMember {
  id: string;
  idpSubject: string | null;
}

export class WorkOsAuthProvider implements AuthProvider {
  readonly name = 'workos';
  private readonly secret: string;
  private readonly logger = new Logger('Auth');
  /** Where audit lines go (one JSON object per line). A field so specs can read it. */
  auditSink: (line: string) => void = (line) => process.stdout.write(`${line}\n`);

  constructor(
    private readonly db: Db,
    private readonly env: WorkOsEnv,
    /** Told when a login creates or adopts a member. Omitted: nothing observes signups. */
    private readonly onSignup?: SignupObserver,
  ) {
    if (!env.JWT_SECRET) {
      // Defensive: the factory already guards this, but never run without a key.
      throw new Error('WorkOsAuthProvider requires JWT_SECRET.');
    }
    this.secret = env.JWT_SECRET;
  }

  async resolveHost(req: ReqLike): Promise<ResolvedHost> {
    const authHeader = header(req, 'authorization');
    const token =
      authHeader && authHeader.startsWith('Bearer ')
        ? authHeader.slice('Bearer '.length).trim()
        : undefined;
    if (!token) throw unauthenticated('Missing bearer token.');

    let claims: JwtClaims;
    try {
      claims = verifyJwtHs256(token, {
        secret: this.secret,
        issuer: this.env.JWT_ISSUER,
        audience: this.env.JWT_AUDIENCE,
      });
    } catch (err) {
      if (err instanceof JwtError) throw unauthenticated('Invalid session token.');
      throw err;
    }

    const accountExtId = typeof claims.account_id === 'string' ? claims.account_id : undefined;
    const sub = typeof claims.sub === 'string' ? claims.sub : undefined;
    if (!accountExtId) throw unauthenticated('Token missing account_id.');
    if (!sub) throw unauthenticated('Token missing sub.');

    const accountId = await this.resolveAccount(accountExtId, claims);
    const member = await this.resolveMember(accountId, sub, claims);
    // When the identity service minted this token: the last moment it vouched
    // for this person in this account (never later than now, whatever the
    // clock). A token without `iat` vouches for nothing: it still signs the
    // person in, but stamps no freshness, so using it cannot extend MCP access.
    const authenticatedAt =
      typeof claims.iat === 'number' && Number.isFinite(claims.iat) ? Math.min(claims.iat * 1000, Date.now()) : null;
    const subject = typeof claims.workos_user_id === 'string' && claims.workos_user_id ? claims.workos_user_id : undefined;
    if (subject && subject !== member.idpSubject) await this.recordSubject(accountId, member.id, subject, authenticatedAt);
    return { accountId, memberId: member.id, authenticatedAt, email: vouchedEmail(claims) };
  }

  /**
   * Record the person's WorkOS user id on the member: what an MCP sign-in
   * token carries as its `sub`, so the MCP door can find this member. Written
   * only when missing or different (this runs on every dashboard request); the
   * latest web login takes it from any other member of the account, in one
   * transaction. Never costs a login: a failure is logged and the next request
   * tries again.
   */
  private async recordSubject(accountId: string, memberId: string, subject: string, authenticatedAt: number | null): Promise<void> {
    try {
      const out = await recordMemberIdpSubject(this.db, accountId, memberId, subject, authenticatedAt);
      if (!out.written) return;
      const line = { ts: new Date().toISOString(), level: 'info', msg: 'auth.idp_subject_recorded', accountId, memberId, takenFrom: out.clearedMemberIds };
      try {
        this.auditSink(JSON.stringify(line));
      } catch {
        /* logging must never break a login */
      }
    } catch (error) {
      // The code only (the driver's, under the query builder's wrapper): a
      // constraint message would carry the subject itself.
      const e = error as { code?: unknown; cause?: { code?: unknown } } | undefined;
      const code = e?.code ?? e?.cause?.code;
      this.logger.warn(`could not record the sign-in subject for member ${memberId}: ${typeof code === 'string' ? code : 'error'}`);
    }
  }

  /** Find (or JIT-create) the local account projected from the token's account_id. */
  private async resolveAccount(externalId: string, claims: JwtClaims): Promise<string> {
    const existing = await this.db.get<{ id: string }>(
      sql`SELECT id FROM account WHERE external_id = ${externalId} LIMIT 1`,
    );
    if (existing) return existing.id;

    const name = typeof claims.name === 'string' && claims.name ? claims.name : 'Account';
    // Race-safe JIT: idempotent on external_id, and a (vanishingly rare) short
    // CODE collision with a concurrent creation regenerates + retries instead
    // of failing the login. The loser of the external_id race re-selects below.
    await insertAccountWithShortCode(this.db, { name, externalId });
    const row = await this.db.get<{ id: string }>(
      sql`SELECT id FROM account WHERE external_id = ${externalId} LIMIT 1`,
    );
    if (!row) throw unauthenticated('Could not resolve account.');
    return row.id;
  }

  /**
   * Is this login one of the platform operator's own staff?
   *
   * The leading `@` is load-bearing and added here if the deployment left it
   * out: a bare suffix test would also accept `someone@notexample.com`, which
   * ends with the same characters and is a different company entirely.
   */
  private isOperator(email: string | null): boolean {
    const configured = this.env.OPERATOR_EMAIL_DOMAIN?.trim().toLowerCase();
    if (!configured || !email) return false;
    const suffix = configured.startsWith('@') ? configured : `@${configured}`;
    return email.toLowerCase().endsWith(suffix);
  }

  /** Find (or JIT-create) the local member projected from the token's sub. */
  private async resolveMember(accountId: string, sub: string, claims: JwtClaims): Promise<ResolvedMember> {
    const existing = await this.db.get<{ id: string; idp_subject: string | null }>(
      sql`SELECT id, idp_subject FROM member WHERE account_id = ${accountId} AND external_id = ${sub} LIMIT 1`,
    );
    if (existing) return { id: existing.id, idpSubject: existing.idp_subject };

    const email = typeof claims.email === 'string' ? claims.email : null;
    const displayName = typeof claims.name === 'string' ? claims.name : null;

    // Adopt a pending invite: a member invited by email exists with no external_id
    // yet. Bind this login's `sub` to it (keeping its granted role) and activate,
    // so invite → first-login lands the user in the role they were granted.
    if (email) {
      const invited = await this.db.get<{ id: string; role: string }>(
        sql`SELECT id, role FROM member
            WHERE account_id = ${accountId} AND external_id IS NULL AND lower(email) = lower(${email})
            ORDER BY created_at ASC LIMIT 1`,
      );
      if (invited) {
        // Bound only while still unbound, and the write reports whether THIS
        // request did it (`RETURNING`, both dialects): the first dashboard load
        // after a login sends parallel requests, and only one of them adopted.
        const adopted = await this.db.get<{ id: string }>(
          sql`UPDATE member SET external_id = ${sub}, status = 'active',
                display_name = COALESCE(display_name, ${displayName})
              WHERE id = ${invited.id} AND external_id IS NULL
              RETURNING id`,
        );
        if (adopted) {
          notifySignup(this.onSignup, {
            accountId,
            memberId: invited.id,
            role: invited.role,
            isFirstMember: false,
            fromInvite: true,
          });
          // An invite never carries a subject: the caller records this login's.
          return { id: invited.id, idpSubject: null };
        }
        // Lost the race: answer with the member bound to THIS login, which is
        // the invite when the winner was the same person signing in twice.
        const bound = await this.db.get<{ id: string; idp_subject: string | null }>(
          sql`SELECT id, idp_subject FROM member WHERE account_id = ${accountId} AND external_id = ${sub} LIMIT 1`,
        );
        return bound ? { id: bound.id, idpSubject: bound.idp_subject } : { id: invited.id, idpSubject: null };
      }
    }

    // The first member of an account is its owner; later JIT members are `member`.
    // The exception is the platform operator's own staff (OPERATOR_EMAIL_DOMAIN),
    // who arrive in an account precisely because someone asked them to work in it:
    // `member` can only see its own resources, so they would land on an empty
    // account and be unable to help. They get `admin` — everything about the
    // account except transferring it.
    const occupied = !!(await this.db.get<{ id: string }>(
      sql`SELECT id FROM member WHERE account_id = ${accountId} LIMIT 1`,
    ));
    const role: AccountRole = !occupied ? 'owner' : this.isOperator(email) ? 'admin' : 'member';
    const id = randomUUID();
    // Auto-handle at creation (short-links §3): the "no handle" state is dead —
    // every member gets `fgomez` (collision → `fgomez2`…) and can rename later.
    const handle = await deriveUniqueHandle(this.db, accountId, displayName, email);
    // Born with the new look (`withNewHostBranding`). In the INSERT rather than
    // a follow-up UPDATE: on a conflict the existing row is left exactly as it
    // is, branding included.
    const born = withNewHostBranding();
    await this.db.run(
      sql`INSERT INTO member (id, account_id, external_id, email, display_name, handle, role, brand_color, booking_page_style, created_at)
          VALUES (${id}, ${accountId}, ${sub}, ${email}, ${displayName}, ${handle}, ${role},
            ${born.brandColor}, ${jsonParam(this.db, born.style)}, ${Date.now()})
          ON CONFLICT (account_id, external_id) DO NOTHING`,
    );
    const row = await this.db.get<{ id: string; idp_subject: string | null }>(
      sql`SELECT id, idp_subject FROM member WHERE account_id = ${accountId} AND external_id = ${sub} LIMIT 1`,
    );
    if (!row) throw unauthenticated('Could not resolve member.');
    // Only the request whose INSERT won reports the signup: a concurrent first
    // login lost the conflict and selects the winner's row, whose id is not
    // the one generated above.
    if (row.id === id) {
      notifySignup(this.onSignup, { accountId, memberId: id, role, isFirstMember: !occupied, fromInvite: false });
    }
    return { id: row.id, idpSubject: row.idp_subject };
  }
}
