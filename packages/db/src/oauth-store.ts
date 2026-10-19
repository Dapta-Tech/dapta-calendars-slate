import { sql } from 'drizzle-orm';
import type { Db } from './client';

/**
 * Storage for the embedded OAuth authorization server (the MCP connector).
 *
 * One table, `oauth_record`, in the shape every oidc-provider adapter uses:
 * a row per artifact keyed by (kind, id). This module is deliberately dumb
 * about OAuth: it stores the id it is given (the API's adapter hashes bearer
 * values before they get here), never parses the payload in SQL, and treats a
 * row whose `expires_at` has passed as absent. The OAuth rules live in
 * `apps/api/src/oauth/`.
 */

/** One stored artifact, as the adapter reads it back. */
export interface OAuthRecordRow {
  kind: string;
  id: string;
  payload: Record<string, unknown>;
  grantId: string | null;
  uid: string | null;
  accountId: string | null;
  expiresAt: number | null;
  consumedAt: number | null;
}

interface DbRow {
  kind: string;
  id: string;
  payload: string;
  grant_id: string | null;
  uid: string | null;
  account_id: string | null;
  expires_at: number | string | null;
  consumed_at: number | string | null;
}

/** `bigint` comes back from the Postgres driver as a string. */
const epoch = (v: number | string | null): number | null => (v === null || v === undefined ? null : Number(v));

function toRecord(row: DbRow): OAuthRecordRow | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    return undefined;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  return {
    kind: row.kind,
    id: row.id,
    payload: payload as Record<string, unknown>,
    grantId: row.grant_id,
    uid: row.uid,
    accountId: row.account_id,
    expiresAt: epoch(row.expires_at),
    consumedAt: epoch(row.consumed_at),
  };
}

export interface UpsertOAuthRecord {
  kind: string;
  id: string;
  payload: Record<string, unknown>;
  grantId?: string | null;
  uid?: string | null;
  accountId?: string | null;
  /** Epoch ms; null or absent = never expires. */
  expiresAt?: number | null;
}

/**
 * Insert or replace one artifact. `consumed_at` survives a replace (a spent
 * token stays spent), and so does `account_id` when the new write names none.
 */
export async function upsertOAuthRecord(db: Db, rec: UpsertOAuthRecord): Promise<void> {
  await db.run(
    sql`INSERT INTO oauth_record (kind, id, payload, grant_id, uid, account_id, expires_at, consumed_at)
        VALUES (${rec.kind}, ${rec.id}, ${JSON.stringify(rec.payload)}, ${rec.grantId ?? null}, ${rec.uid ?? null},
                ${rec.accountId ?? null}, ${rec.expiresAt ?? null}, ${null})
        ON CONFLICT (kind, id) DO UPDATE SET
          payload = excluded.payload,
          grant_id = excluded.grant_id,
          uid = excluded.uid,
          account_id = COALESCE(excluded.account_id, oauth_record.account_id),
          expires_at = excluded.expires_at`,
  );
}

/** One live (unexpired) artifact by id. */
export async function findOAuthRecord(db: Db, kind: string, id: string, now = Date.now()): Promise<OAuthRecordRow | undefined> {
  const row = await db.get<DbRow>(
    sql`SELECT kind, id, payload, grant_id, uid, account_id, expires_at, consumed_at FROM oauth_record
        WHERE kind = ${kind} AND id = ${id} AND (expires_at IS NULL OR expires_at > ${now}) LIMIT 1`,
  );
  return row ? toRecord(row) : undefined;
}

/** One live artifact by its secondary key (oidc-provider's `findByUid`). */
export async function findOAuthRecordByUid(db: Db, kind: string, uid: string, now = Date.now()): Promise<OAuthRecordRow | undefined> {
  const row = await db.get<DbRow>(
    sql`SELECT kind, id, payload, grant_id, uid, account_id, expires_at, consumed_at FROM oauth_record
        WHERE kind = ${kind} AND uid = ${uid} AND (expires_at IS NULL OR expires_at > ${now}) LIMIT 1`,
  );
  return row ? toRecord(row) : undefined;
}

/**
 * Mark an artifact spent. The FIRST consumption time is kept: a replay can
 * never move it forward, which is what keeps a refresh-token retry grace from
 * being extended by replaying inside it.
 */
export async function consumeOAuthRecord(db: Db, kind: string, id: string, now = Date.now()): Promise<void> {
  await db.run(sql`UPDATE oauth_record SET consumed_at = COALESCE(consumed_at, ${now}) WHERE kind = ${kind} AND id = ${id}`);
}

export async function destroyOAuthRecord(db: Db, kind: string, id: string): Promise<void> {
  await db.run(sql`DELETE FROM oauth_record WHERE kind = ${kind} AND id = ${id}`);
}

/**
 * Delete a live artifact and return it, in one statement: at most one caller
 * ever gets it back, without a transaction. For single-use values (consent
 * tickets). `DELETE … RETURNING` works on Postgres and SQLite >= 3.35.
 */
export async function takeOAuthRecord(db: Db, kind: string, id: string, now = Date.now()): Promise<OAuthRecordRow | undefined> {
  const row = await db.get<DbRow>(
    sql`DELETE FROM oauth_record
        WHERE kind = ${kind} AND id = ${id} AND (expires_at IS NULL OR expires_at > ${now})
        RETURNING kind, id, payload, grant_id, uid, account_id, expires_at, consumed_at`,
  );
  return row ? toRecord(row) : undefined;
}

/** Revoke a connection: every artifact of the grant, the grant row included. */
export async function revokeOAuthGrant(db: Db, grantId: string): Promise<void> {
  await db.run(sql`DELETE FROM oauth_record WHERE grant_id = ${grantId}`);
}

/**
 * Push an artifact's expiry out to at least `expiresAt`, never pull it in.
 * Rows that never expire are left alone.
 */
export async function extendOAuthRecordExpiry(db: Db, kind: string, id: string, expiresAt: number): Promise<void> {
  await db.run(
    sql`UPDATE oauth_record SET expires_at = ${expiresAt}
        WHERE kind = ${kind} AND id = ${id} AND expires_at IS NOT NULL AND expires_at < ${expiresAt}`,
  );
}

/** Live rows of one kind for one account, newest expiry first. Account-scoped (invariant 4). */
export async function listOAuthRecordsForAccount(db: Db, accountId: string, kind: string, now = Date.now()): Promise<OAuthRecordRow[]> {
  const rows = await db.all<DbRow>(
    sql`SELECT kind, id, payload, grant_id, uid, account_id, expires_at, consumed_at FROM oauth_record
        WHERE account_id = ${accountId} AND kind = ${kind} AND (expires_at IS NULL OR expires_at > ${now})
        ORDER BY expires_at DESC`,
  );
  return rows.map(toRecord).filter((r): r is OAuthRecordRow => !!r);
}

/** The ids among `ids` that still have a live row of `kind`. */
export async function liveOAuthRecordIds(db: Db, kind: string, ids: string[], now = Date.now()): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db.all<{ id: string }>(
    sql`SELECT id FROM oauth_record WHERE kind = ${kind} AND (expires_at IS NULL OR expires_at > ${now})
        AND id IN (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `,
        )})`,
  );
  return new Set(rows.map((r) => r.id));
}

/**
 * Drop what can no longer be used: every expired row, and refresh tokens spent
 * more than `spentBefore` ago (kept until then only so a replay is recognised
 * as reuse and revokes its connection). Cheap and idempotent; any replica may
 * run it.
 */
export async function purgeOAuthRecords(db: Db, now = Date.now(), spentBefore = now - 7 * 86_400_000): Promise<void> {
  await db.run(sql`DELETE FROM oauth_record WHERE expires_at IS NOT NULL AND expires_at <= ${now}`);
  await db.run(sql`DELETE FROM oauth_record WHERE kind = 'RefreshToken' AND consumed_at IS NOT NULL AND consumed_at < ${spentBefore}`);
}

/** Who a member is, for deciding whether they may hold an OAuth grant. */
export interface OAuthSubject {
  memberId: string;
  accountId: string;
  role: string;
  status: string;
  email: string | null;
  displayName: string | null;
  accountName: string;
  accountCode: string;
}

/** The member behind an OAuth grant (the token's `sub`), or undefined. */
export async function getOAuthSubject(db: Db, memberId: string): Promise<OAuthSubject | undefined> {
  const row = await db.get<{
    member_id: string;
    account_id: string;
    role: string;
    status: string;
    email: string | null;
    display_name: string | null;
    account_name: string;
    account_code: string;
  }>(
    sql`SELECT m.id AS member_id, m.account_id, m.role, m.status, m.email, m.display_name,
               a.name AS account_name, a.code AS account_code
        FROM member m JOIN account a ON a.id = m.account_id
        WHERE m.id = ${memberId} LIMIT 1`,
  );
  if (!row) return undefined;
  return {
    memberId: row.member_id,
    accountId: row.account_id,
    role: row.role,
    status: row.status,
    email: row.email,
    displayName: row.display_name,
    accountName: row.account_name,
    accountCode: row.account_code,
  };
}
