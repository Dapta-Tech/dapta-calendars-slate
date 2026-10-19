import { createHash } from 'node:crypto';
import type { Adapter, AdapterConstructor, AdapterPayload } from 'oidc-provider';
import {
  consumeOAuthRecord,
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
 * 2. REFRESH-TOKEN REUSE. oidc-provider revokes the whole grant when a spent
 *    refresh token comes back. A client whose response was lost and that
 *    retries within `refreshGraceMs` is not a thief, so inside that window a
 *    spent refresh token reads as unspent (it rotates again). The window starts
 *    at the FIRST consumption and replays cannot move it (`consumeOAuthRecord`).
 *
 * 3. UNUSED REGISTRATIONS EXPIRE. A dynamically registered client is stored
 *    with a short life (`dcrUnusedTtlMs`); the service extends it to the life
 *    of the grant when someone actually connects with it.
 */

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
      await upsertOAuthRecord(db, {
        kind: this.kind,
        id: storageId(this.kind, id),
        payload: stored,
        grantId,
        uid: typeof payload.uid === 'string' ? payload.uid : null,
        expiresAt,
      });
      if (this.kind === 'RefreshToken' && grantId) options.onRefreshTokenStored?.(grantId);
    }

    private restore(id: string | undefined, row: Awaited<ReturnType<typeof findOAuthRecord>>): AdapterPayload | undefined {
      if (!row) return undefined;
      const payload: Record<string, unknown> = { ...row.payload };
      if (id !== undefined && this.hashed()) payload.jti = id;
      if (row.consumedAt !== null) {
        const inGrace = this.kind === 'RefreshToken' && now() - row.consumedAt <= options.refreshGraceMs;
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

    async consume(id: string): Promise<void> {
      await consumeOAuthRecord(db, this.kind, storageId(this.kind, id), now());
    }

    async destroy(id: string): Promise<void> {
      await destroyOAuthRecord(db, this.kind, storageId(this.kind, id));
    }

    async revokeByGrantId(grantId: string): Promise<void> {
      await revokeOAuthGrant(db, grantId);
    }
  };
}
