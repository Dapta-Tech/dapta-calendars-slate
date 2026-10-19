import { createHash } from 'node:crypto';
import { errors, type Adapter, type AdapterConstructor, type AdapterPayload } from 'oidc-provider';
import {
  claimOAuthRecord,
  destroyOAuthRecord,
  findOAuthRecord,
  findOAuthRecordByUid,
  revokeOAuthGrant,
  upsertOAuthRecord,
  type Db,
} from '@slate/db';

/**
 * The oidc-provider adapter over the one `oauth_record` table.
 *
 * Three things beyond plain storage, each a security property:
 *
 * 1. BEARER IDS ARE HASHED AT REST. A refresh token, an authorization code or
 *    an interaction id IS the credential, and oidc-provider uses it as the row
 *    id. We store its SHA-256 and drop the copy oidc-provider keeps in the
 *    payload (`jti`), restoring it from the presented value on read. A copy of
 *    the database therefore holds no usable token. Grant and client ids are
 *    identifiers, not secrets, and stay readable (revocation and Connected apps
 *    key on them); sessions stay readable because `findByUid` must return
 *    their id, and they are never sent back by the browser (see the cookie
 *    path in `oauth.service.ts`) or used to skip a login.
 *
 * 2. SINGLE USE UNDER CONCURRENCY, AND REUSE. oidc-provider reads a code or
 *    refresh token, checks it is unspent, then calls `consume`. Two concurrent
 *    requests could both pass the check, so `consume` is an atomic claim
 *    (`claimOAuthRecord`): the loser is refused with `invalid_grant` and the
 *    whole grant is revoked, exactly as oidc-provider does for a token that
 *    comes back after it was spent. The one exception is the refresh retry
 *    grace: a client whose response was lost and that retries within
 *    `refreshGraceMs` is not a thief, so inside that window a spent refresh
 *    token reads as unspent and may rotate again. The window starts at the
 *    FIRST consumption; a replay cannot move it.
 *
 * 3. NOTHING OUTLIVES A REVOKED GRANT. A refresh token or code is only
 *    stored while its grant exists: after the insert the grant row is checked,
 *    and if a concurrent revocation already removed it the new row is deleted
 *    and the issuing request fails. (Such a row would be dead anyway, since
 *    oidc-provider requires the grant on every refresh and nothing re-creates
 *    a revoked grant; this keeps it from existing at all.)
 *
 * 4. UNUSED REGISTRATIONS EXPIRE. A dynamically registered client is stored
 *    with a short life (`dcrUnusedTtlMs`); the service extends it to the life
 *    of the grant when someone actually connects with it.
 */

/** Artifacts that are only valid while their grant exists. */
const GRANT_BOUND_KINDS = new Set(['RefreshToken', 'AuthorizationCode']);

/** Kinds whose id is an identifier, not a credential. */
const PLAIN_ID_KINDS = new Set(['Client', 'Grant', 'Session']);

export const storageId = (kind: string, id: string): string =>
  PLAIN_ID_KINDS.has(kind) ? id : createHash('sha256').update(id).digest('base64url');

export interface OAuthAdapterOptions {
  /** A spent refresh token presented again within this window rotates again instead of revoking. */
  refreshGraceMs: number;
  /** How long a dynamically registered client lives before anyone connects with it. */
  dcrUnusedTtlMs: number;
  /** Told when a refresh token is stored: the grant was just used. */
  onRefreshTokenStored?: (grantId: string) => void;
  /** Told when a concurrent second use revoked a grant. */
  onReuseRevoked?: (kind: string, grantId: string) => void;
  now?: () => number;
}

export function oauthAdapter(db: Db, options: OAuthAdapterOptions): AdapterConstructor {
  const now = options.now ?? Date.now;

  return class OAuthRecordAdapter implements Adapter {
    constructor(private readonly kind: string) {}

    private hashed(): boolean {
      return !PLAIN_ID_KINDS.has(this.kind);
    }

    async upsert(id: string, payload: AdapterPayload, expiresIn?: number): Promise<void> {
      const t = now();
      const stored: Record<string, unknown> = { ...payload };
      if (this.hashed()) delete stored.jti;
      let expiresAt = expiresIn ? t + expiresIn * 1000 : null;
      if (this.kind === 'Client' && expiresAt === null) expiresAt = t + options.dcrUnusedTtlMs;
      const grantId = typeof payload.grantId === 'string' ? payload.grantId : this.kind === 'Grant' ? id : null;
      const key = storageId(this.kind, id);
      await upsertOAuthRecord(db, {
        kind: this.kind,
        id: key,
        payload: stored,
        grantId,
        uid: typeof payload.uid === 'string' ? payload.uid : null,
        expiresAt,
      });
      if (GRANT_BOUND_KINDS.has(this.kind) && grantId && !(await findOAuthRecord(db, 'Grant', grantId, now()))) {
        // Revoked while this request was issuing: never leave a descendant.
        await destroyOAuthRecord(db, this.kind, key);
        throw new errors.InvalidGrant('grant was revoked');
      }
      if (this.kind === 'RefreshToken' && grantId) options.onRefreshTokenStored?.(grantId);
    }

    private restore(id: string | undefined, row: Awaited<ReturnType<typeof findOAuthRecord>>): AdapterPayload | undefined {
      if (!row) return undefined;
      const payload: Record<string, unknown> = { ...row.payload };
      if (id !== undefined && this.hashed()) payload.jti = id;
      if (row.consumedAt !== null) {
        const inGrace = this.inGrace(row.consumedAt);
        if (!inGrace) payload.consumed = Math.floor(row.consumedAt / 1000);
      }
      return payload as AdapterPayload;
    }

    async find(id: string): Promise<AdapterPayload | undefined> {
      return this.restore(id, await findOAuthRecord(db, this.kind, storageId(this.kind, id), now()));
    }

    async findByUid(uid: string): Promise<AdapterPayload | undefined> {
      return this.restore(undefined, await findOAuthRecordByUid(db, this.kind, uid, now()));
    }

    async findByUserCode(): Promise<undefined> {
      // Device flow is not enabled; there are no user codes.
      return undefined;
    }

    private inGrace(consumedAt: number): boolean {
      return this.kind === 'RefreshToken' && options.refreshGraceMs > 0 && now() - consumedAt <= options.refreshGraceMs;
    }

    async consume(id: string): Promise<void> {
      const key = storageId(this.kind, id);
      if (await claimOAuthRecord(db, this.kind, key, now())) return;
      // Spent between oidc-provider's check and here: a concurrent use.
      const row = await findOAuthRecord(db, this.kind, key, now());
      if (row?.consumedAt != null && this.inGrace(row.consumedAt)) return;
      if (row?.grantId) {
        await revokeOAuthGrant(db, row.grantId);
        options.onReuseRevoked?.(this.kind, row.grantId);
      }
      throw new errors.InvalidGrant(`${this.kind === 'RefreshToken' ? 'refresh token' : 'grant'} already used`);
    }

    async destroy(id: string): Promise<void> {
      await destroyOAuthRecord(db, this.kind, storageId(this.kind, id));
    }

    async revokeByGrantId(grantId: string): Promise<void> {
      await revokeOAuthGrant(db, grantId);
    }
  };
}
