/**
 * O2 growth — the data layer behind write-once attribution and the `dapta_sync`
 * outbox rows (#94, decided at #65).
 *
 * The ALLOWLIST that decides what may ever land here, and the ten-minute window
 * the claim enforces, are both defined once in `@slate/shared`
 * (`parseAttribution`, `ATTRIBUTION_WINDOW_MS`). This file holds no policy: it
 * takes an already-parsed blob and an absolute cutoff and performs the write.
 * That keeps the rule unit-testable without a database, keeps every call site
 * necessarily agreeing with it, and keeps `@slate/db` off a dependency on
 * `@slate/shared` it does not otherwise need.
 *
 * Account-scoped throughout (invariant 4).
 */
import { sql } from 'drizzle-orm';
import type { Db } from './client';
import { jsonParam, parseJsonColumn } from './repository';

/**
 * The attribution blob as this layer sees it: an opaque string map. The typed
 * shape (the seven allowlisted keys plus the header-read `referer`) belongs to
 * `@slate/shared`, which owns the parser that produces it.
 */
export type AttributionBlob = Readonly<Record<string, string | undefined>>;

export interface AccountAttribution {
  attribution: AttributionBlob | null;
  /** Write-once claim, epoch-ms. NULL = never captured (and that is truthful). */
  claimedAt: number | null;
}

export async function getAccountAttribution(
  db: Db,
  accountId: string,
): Promise<AccountAttribution> {
  const row = await db.get<{ attribution: unknown; attribution_claimed_at: number | null }>(
    sql`SELECT attribution, attribution_claimed_at FROM account WHERE id = ${accountId} LIMIT 1`,
  );
  if (!row) return { attribution: null, claimedAt: null };
  return {
    attribution: parseJsonColumn<AttributionBlob | null>(row.attribution, null),
    claimedAt: row.attribution_claimed_at == null ? null : Number(row.attribution_claimed_at),
  };
}

export interface AttributionClaim {
  /** True only when THIS call performed the claim. */
  claimed: boolean;
  /** Why it did not, when it did not — for the caller's log, never for the user. */
  reason?: 'ALREADY_CLAIMED' | 'ACCOUNT_TOO_OLD' | 'NO_ACCOUNT';
}

/**
 * Claim attribution write-once, and only for a young account.
 *
 * Two guards live in the one UPDATE's WHERE clause, and they are not the same
 * rule:
 *
 *  - `attribution_claimed_at IS NULL` — WRITE-ONCE. A second click, a retried
 *    request, or a racing tab preserves whatever the account was first given.
 *    Whatever lands here is permanent, so "first touch wins" has to be enforced
 *    rather than intended.
 *  - `created_at > createdAfter` — the account must be NEW. Without it, the
 *    owner of a workspace opened last year could click a campaign link and
 *    stamp that campaign as their workspace's origin, which the funnel would
 *    then report as an acquisition (#65 → Growth funnel). The caller supplies
 *    the cutoff so the ten minutes have exactly one definition.
 *
 * `claimed` comes from the write's own `RETURNING`, never from comparing
 * timestamps afterwards — the mistake O1 corrected in `claimQualification`,
 * where a timestamp comparison told the LOSER it had won whenever two writes
 * shared a millisecond. The same shape matters here because a second `claimed`
 * would be a second acquisition reported to the funnel.
 */
export async function claimAttribution(
  db: Db,
  accountId: string,
  attribution: AttributionBlob,
  opts: { createdAfter: number; now?: number },
): Promise<AttributionClaim> {
  const now = opts.now ?? Date.now();
  const set = sql`SET attribution = ${jsonParam(db, attribution)}, attribution_claimed_at = ${now}`;
  const where = sql`WHERE id = ${accountId}
                      AND attribution_claimed_at IS NULL
                      AND created_at > ${opts.createdAfter}`;

  // `RETURNING` on BOTH dialects, deliberately — one statement, so the row
  // count cannot belong to anyone else's write.
  //
  // O1's `claimQualification` reads SQLite's count with a follow-up
  // `SELECT changes()`. That is a second statement after an `await`, and the
  // await yields a microtask in which a concurrent request's write can land on
  // the same connection and be the one `changes()` reports. SQLite has
  // supported `RETURNING` since 3.35 (this repo's better-sqlite3 ships 3.49),
  // so the dialect branch buys nothing and costs that race. The spec called for
  // `changes()`; this is a deliberate improvement on it, not a divergence.
  const claimed = await db.get<{ attribution_claimed_at: number }>(
    sql`UPDATE account ${set} ${where} RETURNING attribution_claimed_at`,
  );
  if (claimed) return { claimed: true };

  // Separate the refusals for the caller's LOG only. Neither is an error a user
  // ever sees: from the browser's point of view a click that arrives late and a
  // click that arrives second are both simply not recorded.
  const row = await db.get<{ attribution_claimed_at: number | null }>(
    sql`SELECT attribution_claimed_at FROM account WHERE id = ${accountId} LIMIT 1`,
  );
  if (!row) return { claimed: false, reason: 'NO_ACCOUNT' };
  if (row.attribution_claimed_at != null) return { claimed: false, reason: 'ALREADY_CLAIMED' };
  return { claimed: false, reason: 'ACCOUNT_TOO_OLD' };
}

/**
 * Has a `dapta_sync` row with this action already been enqueued for this
 * account?
 *
 * Backs the `early` fire's at-most-once rule. The wizard can be re-opened and
 * the first-answer trigger fires per session, so without this one lead would be
 * pushed to the CRM again on every visit.
 *
 * Deliberately NOT filtered by status: a row that already failed or was skipped
 * still means "we tried to tell the CRM about this account", and re-enqueuing
 * would repeat a delivery that already had its retries.
 *
 * A select-then-insert is correct at this concurrency — the repo's documented
 * model is a single API process with a single worker, and this fires from a
 * first-run screen.
 */
export async function hasDaptaSyncRow(db: Db, accountId: string, action: string): Promise<boolean> {
  const row = await db.get<{ n: number }>(
    sql`SELECT 1 AS n FROM outbox
         WHERE kind = 'dapta_sync' AND action = ${action} AND account_id = ${accountId}
         LIMIT 1`,
  );
  return !!row;
}
