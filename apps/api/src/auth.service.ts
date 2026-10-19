import { ForbiddenException, Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import type { Db } from '@slate/db';
import { verifyApiKey, memberRoleAndLoginSeen, noteMemberLogin } from '@slate/db';
import type { ApiScope } from '@slate/types';
import { AUTH_PROVIDER, DB } from './tokens';
import { header, type AuthProvider, type HostPrincipal, type ReqLike } from './auth.provider';
import { annotateRequestAccount } from './request-log';

export type { HostPrincipal, ReqLike } from './auth.provider';

/** How stale `member.login_seen_at` may get before a verified login stamps it again. */
export const LOGIN_SEEN_REFRESH_MS = 86_400_000;

export interface MachinePrincipal {
  /**
   * For an OAuth connection, `oauth:<grantId>`; for a sign-in through an
   * external authorization server, `login:<memberId>`: the idempotency and
   * rate-limit namespace.
   */
  keyId: string;
  /** The key's public `dcl_<8hex>` handle (`oauth:<grantId>` for OAuth, `login:<8 chars>` for a sign-in); safe to log. */
  prefix: string;
  accountId: string;
  scopes: string[];
  eventTypeIds: string[] | null;
  /** Epoch ms, or null when the key never expires (an OAuth token always expires). */
  expiresAtMs: number | null;
  /** How the caller authenticated. Absent means an API key (every pre-OAuth call site). */
  kind?: 'api_key' | 'oauth';
  /** OAuth only: the member who approved the connection (the token's `sub`), or the member a sign-in acts as. */
  memberId?: string;
  /** OAuth only: the client the token was issued to (a URL for CIMD clients). */
  clientId?: string;
  /** OAuth only: the connection (grant) the token belongs to. Absent on a sign-in through an external server. */
  grantId?: string;
  /** External sign-in only: the authorization server's session (`sid`), when the token carries one. Logged, never trusted. */
  sessionId?: string;
}

/**
 * Auth authority for the API. Host/dashboard identity is delegated to the
 * pluggable `AuthProvider` port (local dev stub / WorkOS overlay) selected on
 * `AUTH_PROVIDER`; machine identity is a hashed API key resolved here (that path
 * is production-grade in OSS too).
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger('Auth');

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(AUTH_PROVIDER) private readonly provider: AuthProvider,
  ) {}

  /**
   * Resolve the authenticated host via the configured provider, then enrich it
   * with the account role (`member.role`) so the permission layer can authorize.
   * The provider stays role-agnostic; role resolution is centralized here so it
   * behaves identically across the local and workos providers. Throws 401 if the
   * provider cannot resolve the host.
   *
   * The same read tells when the upstream identity service last vouched for
   * this member (`login_seen_at`, what an MCP sign-in through an external
   * authorization server is held to). It is stamped with the token's issue
   * time, never the request time: a token minted before someone was removed
   * upstream stays valid until it expires, and using it must not keep the
   * stamp fresh. A stamp a day older than that is renewed here, for every
   * provider, and never moves backwards; a failed write is logged and never
   * costs the request.
   */
  async resolveHost(req: ReqLike): Promise<HostPrincipal> {
    const id = await this.provider.resolveHost(req);
    annotateRequestAccount(req, id.accountId);
    const member = await memberRoleAndLoginSeen(this.db, id.accountId, id.memberId);
    const vouchedAt = Math.min(id.authenticatedAt ?? Date.now(), Date.now());
    if (member && (member.loginSeenAt === null || vouchedAt - member.loginSeenAt >= LOGIN_SEEN_REFRESH_MS)) {
      await noteMemberLogin(this.db, id.accountId, id.memberId, vouchedAt, LOGIN_SEEN_REFRESH_MS).catch((error: unknown) =>
        this.logger.warn(`could not stamp the login of member ${id.memberId}: ${error instanceof Error ? error.message : String(error)}`),
      );
    }
    return { ...id, role: member?.role ?? 'member' };
  }

  /**
   * Verify one presented API key and return its principal, or null when it is
   * unknown, revoked or expired. No scope check: the MCP door authenticates once
   * per request and then checks scopes per tool.
   */
  async authenticateKey(key: string): Promise<MachinePrincipal | null> {
    return key ? verifyApiKey(this.db, key) : null;
  }

  /**
   * Resolve a machine principal from an API key and enforce a required scope.
   * A list means "any of": the REST cancel routes take `bookings:cancel` or the
   * older `bookings:write`, so keys minted before the cancel scope existed keep
   * working.
   */
  async resolveMachine(
    req: ReqLike,
    requiredScope: ApiScope | readonly ApiScope[],
  ): Promise<MachinePrincipal> {
    const auth = header(req, 'authorization');
    const bearer = auth?.startsWith('Bearer ') ? auth.slice('Bearer '.length) : undefined;
    const key = bearer ?? header(req, 'x-api-key');
    const principal = key ? await verifyApiKey(this.db, key) : null;
    if (!principal)
      throw new UnauthorizedException({ error: 'UNAUTHENTICATED', message: 'Invalid API key.' });
    annotateRequestAccount(req, principal.accountId);
    const accepted = Array.isArray(requiredScope) ? requiredScope : [requiredScope as ApiScope];
    if (!accepted.some((scope) => principal.scopes.includes(scope)))
      throw new ForbiddenException({ error: 'FORBIDDEN', message: `Missing scope: ${accepted.join(' or ')}` });
    return principal;
  }

  /**
   * Enforce the machine resource allowlist (anti-uid-probing): if the key is
   * scoped to specific event types, an out-of-scope target is indistinguishable
   * from not-found — both surface as 403, never revealing existence.
   */
  assertEventTypeAllowed(principal: MachinePrincipal, eventTypeId: string | null): void {
    if (principal.eventTypeIds && (!eventTypeId || !principal.eventTypeIds.includes(eventTypeId)))
      throw new ForbiddenException({ error: 'FORBIDDEN', message: 'Not permitted for this resource.' });
  }
}
