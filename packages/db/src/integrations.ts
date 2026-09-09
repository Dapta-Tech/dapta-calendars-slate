/**
 * `account_integration` — the data layer for third-party integration
 * credentials (H1a / #63 / ADR 0001).
 *
 * The rule this module exists to enforce: **a stored token leaves here exactly
 * once, decrypted, on its way to an adapter, and never in any other direction.**
 * Nothing that a controller can serialize carries the cipher, so "never echoed
 * back to the client" is a property of the types rather than a habit of the
 * caller. `IntegrationStatusRow` is the shape a status view may have;
 * `resolveProviderToken` is the one door the plaintext comes through.
 *
 * Dialect-agnostic like the rest of `@slate/db`: portable SQL through the `Db`
 * handle, JSON via `jsonParam`/`parseJsonColumn` (jsonb on Postgres, TEXT JSON
 * on SQLite).
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Db } from './client';
import { jsonParam, parseJsonColumn } from './repository';
import {
  decryptSecret,
  encryptSecret,
  isPlaceholderSecret,
  secretAad,
  secretLast4,
} from './crypto';

/** `disconnected` is a soft delete: the credential is scrubbed, the row is not. */
export type IntegrationStatus = 'connected' | 'unhealthy' | 'disconnected';

/**
 * The structured half of a provider failure. HubSpot's 403 body carries
 * `category: "MISSING_SCOPES"` and `errors[].context.requiredGranularScopes`,
 * a scope NAME LIST (verified against a live portal in #74) — so a UI can name
 * the exact checkbox the host missed instead of showing a sentence. Stored as
 * data, never flattened to prose.
 */
export interface IntegrationErrorDetail {
  category?: string | null;
  requiredGranularScopes?: string[];
}

/**
 * Everything a client may ever see about an integration. Note what is ABSENT:
 * `token_cipher`. This interface is the contract that keeps a credential from
 * reaching a browser by accident.
 */
export interface IntegrationStatusRow {
  id: string;
  provider: string;
  status: IntegrationStatus;
  label: string | null;
  tokenLast4: string | null;
  lastCheckAt: number | null;
  lastCheckOk: boolean | null;
  lastCheckDetail: string | null;
  lastErrorDetail: IntegrationErrorDetail | null;
  createdAt: number;
  updatedAt: number;
}

interface RawRow {
  id: string;
  provider: string;
  status: string;
  token_cipher: string | null;
  label: string | null;
  token_last4: string | null;
  last_check_at: number | null;
  last_check_ok: number | null;
  last_check_detail: string | null;
  last_error_detail: unknown;
  created_at: number;
  updated_at: number;
}

function toStatusRow(r: RawRow): IntegrationStatusRow {
  return {
    id: r.id,
    provider: r.provider,
    status: r.status as IntegrationStatus,
    label: r.label,
    tokenLast4: r.token_last4,
    lastCheckAt: r.last_check_at == null ? null : Number(r.last_check_at),
    lastCheckOk: r.last_check_ok == null ? null : Number(r.last_check_ok) === 1,
    lastCheckDetail: r.last_check_detail,
    lastErrorDetail: parseJsonColumn<IntegrationErrorDetail | null>(r.last_error_detail, null),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

const SELECT_COLUMNS = sql`id, provider, status, token_cipher, label, token_last4,
  last_check_at, last_check_ok, last_check_detail, last_error_detail, created_at, updated_at`;

/** Every integration on an account, safe to serialize. Account-scoped (invariant 4). */
export async function listAccountIntegrations(
  db: Db,
  accountId: string,
): Promise<IntegrationStatusRow[]> {
  const rows = await db.all<RawRow>(
    sql`SELECT ${SELECT_COLUMNS} FROM account_integration
        WHERE account_id = ${accountId} ORDER BY provider`,
  );
  return rows.map(toStatusRow);
}

/** One integration, safe to serialize. */
export async function getAccountIntegration(
  db: Db,
  accountId: string,
  provider: string,
): Promise<IntegrationStatusRow | null> {
  const row = await db.get<RawRow>(
    sql`SELECT ${SELECT_COLUMNS} FROM account_integration
        WHERE account_id = ${accountId} AND provider = ${provider} LIMIT 1`,
  );
  return row ? toStatusRow(row) : null;
}

/**
 * Store (or replace) an account's credential for a provider.
 *
 * UPSERT on `(account_id, provider)`, which is what makes reconnecting the same
 * portal reuse the SAME row id — and the id is what `booking_reference`
 * .destination` points at, so existing bookings keep pointing at their meetings
 * and a later cancellation updates rather than duplicates (#63).
 *
 * The caller MUST have verified the token by using it before calling this
 * (fail-closed connect). This function only persists.
 */
export async function upsertAccountIntegration(
  db: Db,
  input: {
    accountId: string;
    provider: string;
    /** Plaintext credential; encrypted here and never stored or logged raw. */
    token: string;
    key: Buffer;
    label?: string | null;
    now?: number;
  },
): Promise<IntegrationStatusRow> {
  const now = input.now ?? Date.now();
  const cipher = encryptSecret(
    input.token,
    input.key,
    secretAad(input.accountId, input.provider),
  );
  const last4 = secretLast4(input.token);
  const existing = await db.get<{ id: string }>(
    sql`SELECT id FROM account_integration
        WHERE account_id = ${input.accountId} AND provider = ${input.provider} LIMIT 1`,
  );
  if (existing) {
    // Reconnect: same row, same id. A successful connect also clears the health
    // history — a stale "missing scope" beside a freshly-verified token would
    // send the host looking for a problem they just fixed.
    await db.run(
      sql`UPDATE account_integration
          SET token_cipher = ${cipher}, token_last4 = ${last4},
              label = ${input.label ?? null}, status = 'connected',
              last_check_at = ${now}, last_check_ok = 1, last_check_detail = NULL,
              last_error_detail = NULL, updated_at = ${now}
          WHERE id = ${existing.id}`,
    );
  } else {
    await db.run(
      sql`INSERT INTO account_integration
            (id, account_id, provider, status, token_cipher, label, token_last4,
             last_check_at, last_check_ok, last_check_detail, last_error_detail,
             created_at, updated_at)
          VALUES (${randomUUID()}, ${input.accountId}, ${input.provider}, 'connected',
            ${cipher}, ${input.label ?? null}, ${last4},
            ${now}, 1, NULL, NULL, ${now}, ${now})`,
    );
  }
  const row = await getAccountIntegration(db, input.accountId, input.provider);
  if (!row) throw new Error('account_integration row vanished immediately after write');
  return row;
}

/**
 * Soft-disconnect: scrub the credential, keep the identity.
 *
 * NOT a DELETE, and that is load-bearing. #63 requires that reconnecting the
 * same portal keeps existing bookings pointed at their meetings, and the thing
 * pointing at them is this row's `id`. A hard delete mints a new id on
 * reconnect, every `booking_reference` stops matching, and the first
 * cancellation after a reconnect creates a SECOND meeting instead of updating
 * the first. Nothing is ever deleted in the remote CRM.
 */
export async function disconnectAccountIntegration(
  db: Db,
  accountId: string,
  provider: string,
  now = Date.now(),
): Promise<boolean> {
  const existing = await db.get<{ id: string }>(
    sql`SELECT id FROM account_integration
        WHERE account_id = ${accountId} AND provider = ${provider} LIMIT 1`,
  );
  if (!existing) return false;
  await db.run(
    sql`UPDATE account_integration
        SET status = 'disconnected', token_cipher = NULL, last_error_detail = NULL,
            last_check_detail = NULL, updated_at = ${now}
        WHERE id = ${existing.id}`,
  );
  // The user meant it: queued write-out is a decision that was reversed, not a
  // delivery that failed. `skipped` records that once, with a reason, instead of
  // burning retries and filing the result under failures.
  await db.run(
    sql`UPDATE outbox
        SET status = 'skipped', last_error = 'integration disconnected', updated_at = ${now}
        WHERE kind = 'crm' AND status = 'pending' AND account_id = ${accountId}`,
  );
  return true;
}

/**
 * Record the outcome of a real call. `ok` marks the integration healthy;
 * a failure marks it `unhealthy` and stores the STRUCTURED provider error.
 *
 * It never marks an integration `disconnected` — #63: never auto-disable. An
 * unhealthy integration keeps its credential, so fixing the scope in the portal
 * is enough to make it work again without re-pasting anything.
 */
export async function recordIntegrationHealth(
  db: Db,
  input: {
    integrationId: string;
    ok: boolean;
    detail?: string | null;
    errorDetail?: IntegrationErrorDetail | null;
    now?: number;
  },
): Promise<void> {
  const now = input.now ?? Date.now();
  const status = input.ok ? 'connected' : 'unhealthy';
  await db.run(
    sql`UPDATE account_integration
        SET status = ${status}, last_check_at = ${now}, last_check_ok = ${input.ok ? 1 : 0},
            last_check_detail = ${input.detail ?? null},
            last_error_detail = ${jsonParam(db, input.errorDetail ?? null)},
            updated_at = ${now}
        WHERE id = ${input.integrationId}`,
  );
}

/** A usable credential plus the id that identifies where it was written from. */
export interface ResolvedProviderToken {
  token: string;
  /** The `account_integration` id, or null when the env fallback supplied it. */
  integrationId: string | null;
}

/**
 * Hand an adapter a usable token — the ONE place plaintext leaves this module.
 *
 * Order: a stored, non-disconnected credential wins; otherwise the deployment's
 * env fallback, so a zero-config self-hoster can wire one portal without a
 * dashboard. `null` means "no credential", which callers treat as *skip this
 * work*, never as a failure to retry.
 *
 * The adapter never receives `key` — the layer that owns the row owns the
 * secret at rest (#63).
 */
export async function resolveProviderToken(
  db: Db,
  accountId: string,
  provider: string,
  key: Buffer | null,
  envFallback?: string | null,
): Promise<ResolvedProviderToken | null> {
  const row = await db.get<{ id: string; status: string; token_cipher: string | null }>(
    sql`SELECT id, status, token_cipher FROM account_integration
        WHERE account_id = ${accountId} AND provider = ${provider} LIMIT 1`,
  );
  // An account that connected a credential has expressed an opinion, and the
  // env fallback must not quietly override it — including when the opinion was
  // "disconnect", which yields nothing at all.
  if (row && row.status === 'disconnected') return null;
  if (row?.token_cipher) {
    if (!key) {
      // Loud, not silent. A stored credential that cannot be opened is a
      // deployment fault; falling through to the env fallback here would write
      // this account's bookings into whatever portal the operator configured.
      throw new Error(
        `cannot decrypt the stored ${provider} credential: INTEGRATION_ENCRYPTION_KEY is not configured.`,
      );
    }
    return {
      token: decryptSecret(row.token_cipher, key, secretAad(accountId, provider)),
      integrationId: row.id,
    };
  }
  if (isPlaceholderSecret(envFallback)) return null;
  return { token: (envFallback as string).trim(), integrationId: null };
}

/**
 * The `booking_reference.destination` for a CRM write-out.
 *
 * Prefixed so a row is self-describing beside the opaque calendar connection
 * refs that share the table, and `env` stands in when the credential came from
 * the deployment fallback and there is no row id to name. Stable across a
 * disconnect/reconnect cycle, which is the whole point (see
 * `disconnectAccountIntegration`).
 */
export function crmDestination(integrationId: string | null): string {
  return `crm:${integrationId ?? 'env'}`;
}
