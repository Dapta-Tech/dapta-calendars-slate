/**
 * The transactional OUTBOX (B7 / audit DM1). Every durable side-effect that used
 * to be fire-and-forget — calendar event write-out and webhook delivery — is now
 * recorded as an `outbox` row the instant it is due, and a worker (see
 * apps/api/src/outbox.worker.ts) drains it with retry + exponential backoff.
 *
 * Why this matters:
 *   - No silent loss. A provider outage or a transient network error no longer
 *     drops the effect on the floor — the row survives and retries.
 *   - No orphans. Calendar write-out stays idempotent via the DH1 claim
 *     (`booking_reference` unique index), so a retry can never double-create a
 *     remote event.
 *   - A durable delivery log. status/attempts/last_error on each row is the
 *     record of what was attempted and why it failed.
 *
 * This module is pure DB (depends only on the `Db` port) and dialect-agnostic:
 * the same code runs on SQLite (clone-and-run) and Postgres (prod). The *what to
 * do* for each row lives in the API app (it needs the CalendarProvider and
 * fetch); this module owns only the queue mechanics.
 *
 * Concurrency: a row is CLAIMED with a lease (`claimDueOutbox`): one
 * conditional UPDATE sets `lease_until`/`lease_token` only on rows that are due
 * and not already leased, so two API replicas (or two workers in one process)
 * never deliver the same row at once, on either dialect. The outcome is written
 * only by the lease's holder, and a worker that dies mid-delivery has its rows
 * claimed again once the lease runs out. A claim can also ask for each
 * destination (a webhook subscriber, a booking) to be served one row at a time,
 * in the order queued, which keeps one slow destination from occupying every
 * delivery slot and keeps a retry from letting a later row overtake it.
 */
import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import type { Db } from './client';

/**
 * `dapta_sync` (contact → Dapta's OWN marketing CRM) and `iam_onboarding` (the
 * lead-score post) are O2's two kinds, and they are deliberately SEPARATE rows
 * rather than one row doing both calls: they retry independently, so a CRM
 * failure can never re-post the qualification responses and mint a second lead
 * score for one workspace. The invite path simply never enqueues the second
 * kind, which is how "the invite path skips the IAM entirely" (#65) holds by
 * construction rather than by a conditional inside a shared handler.
 *
 * The `outbox.kind` column is unconstrained text, so adding a kind is a
 * type-level change only — no migration.
 */
export type OutboxKind =
  | 'calendar'
  | 'webhook'
  | 'email'
  | 'dapta_sync'
  | 'iam_onboarding'
  /**
   * H1a (#63): the CRM write-out. ONE row per lifecycle transition, and the
   * accept row does BOTH halves -- resolve the contact and create the meeting
   * associated to it. Two rows would need an ordering the outbox does not
   * have, and the meeting cannot be associated before the contact id exists.
   */
  | 'crm';
/**
 * `skipped` = deliberately not performed (e.g. a legacy email row whose tenant
 * context is unrecoverable on a transport that requires it) — recorded ONCE
 * with a reason, never retried. Distinct from `failed` (exhausted retries).
 */
export type OutboxStatus = 'pending' | 'done' | 'failed' | 'skipped';

export interface OutboxRow {
  id: string;
  kind: OutboxKind;
  action: string;
  bookingUid: string | null;
  accountId: string | null;
  webhookId: string | null;
  payload: string | null;
  status: OutboxStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  /** Epoch-ms until which a worker owns the row; null when nobody does. */
  leaseUntil: number | null;
  /** The claim that holds the lease; pass it back when marking the outcome. */
  leaseToken: string | null;
  /** Epoch-ms of the first failed attempt; null until one fails. */
  firstFailedAt: number | null;
  /** Rows of one kind sharing it are delivered one at a time, in queue order. */
  orderKey: string | null;
}

export interface EnqueueOutboxInput {
  kind: OutboxKind;
  action: string;
  bookingUid?: string | null;
  accountId?: string | null;
  webhookId?: string | null;
  /** Serialized JSON body (webhook deliveries); omit for calendar jobs. */
  payload?: string | null;
  maxAttempts?: number;
  /** Epoch-ms; injected so callers/tests control the clock. Defaults to Date.now(). */
  now?: number;
  /**
   * Rows of one kind that share this key are delivered one at a time, in the
   * order queued (see `ClaimOutboxOptions.inOrder`). Omitted: the booking for
   * most rows, and the subscriber plus the booking for a webhook row, so one
   * subscriber's events about one booking keep their order while its events
   * about other bookings are not held behind them. Email rows pass the
   * booking and the side (attendee or host), so the two sides never wait on
   * each other. `null` orders the row with nothing.
   */
  orderKey?: string | null;
  /**
   * Epoch-ms at which this row first becomes due. Defaults to `now` (immediate).
   * Set it in the FUTURE to schedule delivery — e.g. a reminder at `start − lead`.
   * The worker drains rows with `next_attempt_at <= now`, so a future value stays
   * dormant until its time.
   */
  nextAttemptAt?: number;
}

/**
 * The attempt budget every row is guaranteed before the retry horizon can end
 * it; overridable per row. With a horizon of 0 it is the whole retry ceiling,
 * as it always was.
 */
export const DEFAULT_MAX_ATTEMPTS = 5;

/** How long a claim owns a row unless the caller says otherwise. */
export const DEFAULT_LEASE_MS = 5 * 60_000;

/** The longest wait between two attempts. */
export const MAX_BACKOFF_MS = 15 * 60_000;

/**
 * Exponential backoff for the NEXT retry, given the number of attempts already
 * made (1 after the first failure). 1s, 2s, 4s, 8s ... capped at 15 min. Kept
 * pure so `nextAttemptAt = now + backoffMs(attempts)` is predictable; the
 * worker spreads it with `retryDelayMs`.
 */
export function backoffMs(attempts: number): number {
  const base = 1000;
  return Math.min(MAX_BACKOFF_MS, base * 2 ** Math.max(0, attempts - 1));
}

/**
 * `backoffMs`, shortened by up to 20% at random, so rows that failed together
 * (a mail transport that went down for everyone) do not all come back at the
 * same instant. Never longer than `backoffMs`: a row is always due again by
 * the time the plain schedule says it is.
 */
export function retryDelayMs(attempts: number, random: () => number = Math.random): number {
  const r = Math.min(1, Math.max(0, random()));
  return Math.round(backoffMs(attempts) * (0.8 + 0.2 * r));
}

/**
 * Whether a row that has just failed its `attempts`-th attempt is done
 * retrying: it has spent its attempt budget AND it has been failing for at
 * least `horizonMs` (counted from its first failure, `now` for a first
 * failure). A horizon of 0 gives the old rule: the budget alone decides.
 */
export function outboxRetriesExhausted(
  row: Pick<OutboxRow, 'maxAttempts' | 'firstFailedAt'>,
  attempts: number,
  now: number,
  horizonMs: number,
): boolean {
  if (attempts < row.maxAttempts) return false;
  const since = row.firstFailedAt ?? now;
  return now - since >= Math.max(0, horizonMs);
}

/** Record a due unit of work. Returns the new row id. */
/** The order key a row gets when its caller names none; see `EnqueueOutboxInput.orderKey`. */
export function defaultOrderKey(
  input: Pick<EnqueueOutboxInput, 'kind' | 'bookingUid' | 'webhookId'>,
): string | null {
  if (input.kind === 'webhook') {
    if (!input.webhookId) return null;
    return input.bookingUid ? `${input.webhookId}|${input.bookingUid}` : input.webhookId;
  }
  return input.bookingUid ?? null;
}

export async function enqueueOutbox(db: Db, input: EnqueueOutboxInput): Promise<string> {
  const id = randomUUID();
  const now = input.now ?? Date.now();
  const dueAt = input.nextAttemptAt ?? now;
  const orderKey = input.orderKey !== undefined ? input.orderKey : defaultOrderKey(input);
  await db.run(
    sql`INSERT INTO outbox
          (id, kind, action, booking_uid, account_id, webhook_id, payload,
           status, attempts, max_attempts, next_attempt_at, last_error, created_at, updated_at, order_key)
        VALUES (${id}, ${input.kind}, ${input.action}, ${input.bookingUid ?? null},
          ${input.accountId ?? null}, ${input.webhookId ?? null}, ${input.payload ?? null},
          'pending', 0, ${input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS}, ${dueAt}, NULL, ${now}, ${now}, ${orderKey})`,
  );
  return id;
}

/**
 * Delete still-PENDING rows matching a booking + kind + action — used to cancel
 * scheduled reminders when a booking is cancelled/declined or moved (before they
 * fire). Never touches rows already `done`/`failed`.
 */
export async function deletePendingOutbox(
  db: Db,
  filter: { bookingUid: string; kind: OutboxKind; action: string },
): Promise<void> {
  await db.run(
    sql`DELETE FROM outbox
        WHERE status = 'pending' AND booking_uid = ${filter.bookingUid}
          AND kind = ${filter.kind} AND action = ${filter.action}`,
  );
}

function mapRow(r: Record<string, unknown>): OutboxRow {
  return {
    id: String(r.id),
    kind: r.kind as OutboxKind,
    action: String(r.action),
    bookingUid: (r.booking_uid as string | null) ?? null,
    accountId: (r.account_id as string | null) ?? null,
    webhookId: (r.webhook_id as string | null) ?? null,
    payload: (r.payload as string | null) ?? null,
    status: r.status as OutboxStatus,
    attempts: Number(r.attempts),
    maxAttempts: Number(r.max_attempts),
    nextAttemptAt: Number(r.next_attempt_at),
    lastError: (r.last_error as string | null) ?? null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
    leaseUntil: r.lease_until == null ? null : Number(r.lease_until),
    leaseToken: (r.lease_token as string | null) ?? null,
    firstFailedAt: r.first_failed_at == null ? null : Number(r.first_failed_at),
    orderKey: (r.order_key as string | null) ?? null,
  };
}

export interface ClaimOutboxOptions {
  /** Only these kinds (a worker lane). Omitted: every kind. */
  kinds?: readonly OutboxKind[];
  /** Every kind but these (the lane for kinds no other lane names). */
  excludeKinds?: readonly string[];
  /** How long the claim owns its rows. Default `DEFAULT_LEASE_MS`. */
  leaseMs?: number;
  /** The claim's identity, written to `lease_token`. Default: a fresh UUID. */
  token?: string;
  /**
   * Rows of one kind that share an order key (`order_key`; see
   * `EnqueueOutboxInput.orderKey`) are delivered ONE AT A TIME and IN THE ORDER
   * THEY WERE QUEUED. Only the oldest active row of a key can be claimed, and
   * only when it is due and not already in flight; while it backs off after a
   * failure, the rows queued after it wait. That keeps a booking's calendar
   * create ahead of its delete, its "confirmed" mail ahead of its "cancelled",
   * and a subscriber's `booking.created` ahead of its `booking.cancelled`,
   * however long a retry takes. "Active" means attempted at least once, or due:
   * a row scheduled for later and never tried yet (a reminder) blocks nobody.
   * Rows with no key are never held back.
   *
   * Also: one webhook SUBSCRIBER has at most one delivery in flight, whatever
   * bookings its rows are about, so a slow subscriber takes one slot, never
   * all of them.
   */
  inOrder?: boolean;
}

/**
 * A row's order key, as SQL. A row queued before the column existed falls back
 * to what it was ordered by then: its subscriber for a webhook, else its booking.
 */
const ORDER_KEY = (alias: string) =>
  sql.raw(
    `COALESCE(${alias}.order_key, CASE WHEN ${alias}.kind = 'webhook' THEN ${alias}.webhook_id ELSE ${alias}.booking_uid END)`,
  );

/**
 * CLAIM up to `limit` pending rows that are due (`next_attempt_at <= now`) and
 * not leased by anyone else, oldest first, and lease them to this claim.
 *
 * Two steps, safe under concurrency on both dialects: a read picks candidates,
 * then ONE conditional UPDATE leases only those still due and unleased. Two
 * claimers that pick the same row cannot both win it: Postgres re-checks the
 * UPDATE's condition against the row after the other claimer's commit, and
 * SQLite runs one writer at a time. The returned rows carry `leaseToken`; hand
 * it back to the `markOutbox*` call that records the outcome.
 */
export async function claimDueOutbox(
  db: Db,
  now: number,
  limit = 50,
  opts: ClaimOutboxOptions = {},
): Promise<OutboxRow[]> {
  if (limit <= 0) return [];
  const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
  const token = opts.token ?? randomUUID();
  const lane: SQL[] = [];
  if (opts.kinds) {
    if (opts.kinds.length === 0) return [];
    lane.push(sql`o.kind IN (${sql.join(opts.kinds.map((k) => sql`${k}`), sql`, `)})`);
  }
  if (opts.excludeKinds && opts.excludeKinds.length > 0) {
    lane.push(sql`o.kind NOT IN (${sql.join(opts.excludeKinds.map((k) => sql`${k}`), sql`, `)})`);
  }
  const due = [
    sql`o.status = 'pending'`,
    sql`o.next_attempt_at <= ${now}`,
    sql`(o.lease_until IS NULL OR o.lease_until <= ${now})`,
    ...lane,
  ];
  let candidates: Array<{ id: string; kind: string; webhook_id: string | null }>;
  if (opts.inOrder) {
    // Subscribers with a delivery already in flight, on any worker or replica.
    const busySubscribers = (
      await db.all<{ webhook_id: string }>(
        sql`SELECT DISTINCT o.webhook_id AS webhook_id FROM outbox o
            WHERE ${sql.join(
              [sql`o.status = 'pending'`, sql`o.lease_until > ${now}`, sql`o.kind = 'webhook'`, sql`o.webhook_id IS NOT NULL`, ...lane],
              sql` AND `,
            )}`,
      )
    ).map((r) => r.webhook_id);
    // Rank every ACTIVE row of an order key by age and offer only the head,
    // and only when it is due and free: a head in flight or backing off holds
    // its whole key. The range bound lets the status/next_attempt_at index
    // skip far-future reminders: a row backing off is due within
    // MAX_BACKOFF_MS (markOutboxRetry clamps it).
    const heads = await db.all<{ id: string; kind: string; webhook_id: string | null }>(
      sql`SELECT id, kind, webhook_id FROM (
            SELECT o.id, o.kind, o.webhook_id, o.next_attempt_at, o.created_at, o.lease_until,
                   ROW_NUMBER() OVER (
                     PARTITION BY o.kind, COALESCE(${ORDER_KEY('o')}, o.id)
                     ORDER BY o.created_at, o.id
                   ) AS rn
            FROM outbox o
            WHERE ${sql.join(
              [
                sql`o.status = 'pending'`,
                sql`o.next_attempt_at <= ${now + MAX_BACKOFF_MS}`,
                sql`(o.attempts > 0 OR o.next_attempt_at <= ${now})`,
                ...lane,
              ],
              sql` AND `,
            )}
          ) ranked
          WHERE rn = 1 AND next_attempt_at <= ${now} AND (lease_until IS NULL OR lease_until <= ${now})
          ORDER BY next_attempt_at, created_at, id
          LIMIT ${limit * 4}`,
    );
    // At most one per subscriber, and none for a subscriber already busy.
    const taken = new Set(busySubscribers);
    candidates = [];
    for (const h of heads) {
      if (candidates.length >= limit) break;
      if (h.kind === 'webhook' && h.webhook_id) {
        if (taken.has(h.webhook_id)) continue;
        taken.add(h.webhook_id);
      }
      candidates.push(h);
    }
  } else {
    candidates = await db.all<{ id: string; kind: string; webhook_id: string | null }>(
      sql`SELECT o.id, o.kind, o.webhook_id FROM outbox o WHERE ${sql.join(due, sql` AND `)}
          ORDER BY o.next_attempt_at, o.created_at, o.id
          LIMIT ${limit}`,
    );
  }
  if (candidates.length === 0) return [];
  const ids = sql.join(
    candidates.map((c) => sql`${c.id}`),
    sql`, `,
  );
  const claimed = await db.all<Record<string, unknown>>(
    sql`UPDATE outbox SET lease_until = ${now + leaseMs}, lease_token = ${token}
        WHERE id IN (${ids}) AND status = 'pending' AND next_attempt_at <= ${now}
          AND (lease_until IS NULL OR lease_until <= ${now})
        RETURNING *`,
  );
  return claimed
    .map(mapRow)
    .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt || a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
}

/**
 * Extend a claim that is still being worked on, so a slow delivery is not
 * taken over by another worker mid-flight. Answers false once the lease is
 * no longer this claim's.
 */
export async function renewOutboxLease(
  db: Db,
  id: string,
  leaseToken: string,
  leaseUntil: number,
): Promise<boolean> {
  const row = await db.get<{ id: string }>(
    sql`UPDATE outbox SET lease_until = ${leaseUntil}
        WHERE id = ${id} AND status = 'pending' AND lease_token = ${leaseToken}
        RETURNING id`,
  );
  return !!row;
}

/** The lease check every outcome write carries when the caller holds a claim. */
const heldBy = (token: string | null | undefined) => (token ? sql` AND lease_token = ${token}` : sql``);

/**
 * Mark a row delivered. With `leaseToken`, only while that claim still holds
 * it; answers whether the row was written (false: the lease was lost).
 */
export async function markOutboxDone(
  db: Db,
  id: string,
  now = Date.now(),
  leaseToken?: string | null,
): Promise<boolean> {
  const row = await db.get<{ id: string }>(
    sql`UPDATE outbox SET status = 'done', updated_at = ${now}, last_error = NULL,
          lease_until = NULL, lease_token = NULL
        WHERE id = ${id}${heldBy(leaseToken)}
        RETURNING id`,
  );
  return !!row;
}

/**
 * Record a failed attempt and schedule the next one. `attempts` is the new
 * (incremented) count; the row stays `pending` and is due again `delayMs`
 * after `now` (default `backoffMs(attempts)`, at most `MAX_BACKOFF_MS`), counted from the FAILURE, not
 * from when the batch it was in started. The first failure is remembered in
 * `first_failed_at`, which the retry horizon counts from. Releases the lease.
 */
export async function markOutboxRetry(
  db: Db,
  id: string,
  args: { attempts: number; error: string; now?: number; delayMs?: number; leaseToken?: string | null },
): Promise<boolean> {
  const now = args.now ?? Date.now();
  // Never later than MAX_BACKOFF_MS: an in-order claim looks for a backing-off
  // row only that far ahead (see `claimDueOutbox`).
  const nextAt = now + Math.min(MAX_BACKOFF_MS, Math.max(0, args.delayMs ?? backoffMs(args.attempts)));
  const row = await db.get<{ id: string }>(
    sql`UPDATE outbox
        SET attempts = ${args.attempts}, next_attempt_at = ${nextAt},
            last_error = ${args.error.slice(0, 1000)}, updated_at = ${now},
            first_failed_at = COALESCE(first_failed_at, ${now}),
            lease_until = NULL, lease_token = NULL
        WHERE id = ${id}${heldBy(args.leaseToken)}
        RETURNING id`,
  );
  return !!row;
}

/**
 * Deliberately not performed — terminal on the FIRST decision (no retry
 * schedule burned), with the reason kept as the log record.
 */
export async function markOutboxSkipped(
  db: Db,
  id: string,
  args: { reason: string; now?: number; leaseToken?: string | null },
): Promise<boolean> {
  const now = args.now ?? Date.now();
  const row = await db.get<{ id: string }>(
    sql`UPDATE outbox
        SET status = 'skipped', last_error = ${args.reason.slice(0, 1000)}, updated_at = ${now},
            lease_until = NULL, lease_token = NULL
        WHERE id = ${id}${heldBy(args.leaseToken)}
        RETURNING id`,
  );
  return !!row;
}

/** Give up: the row exhausted its retries. Terminal state; kept as the log. */
export async function markOutboxFailed(
  db: Db,
  id: string,
  args: { attempts: number; error: string; now?: number; leaseToken?: string | null },
): Promise<boolean> {
  const now = args.now ?? Date.now();
  const row = await db.get<{ id: string }>(
    sql`UPDATE outbox
        SET status = 'failed', attempts = ${args.attempts},
            last_error = ${args.error.slice(0, 1000)}, updated_at = ${now},
            first_failed_at = COALESCE(first_failed_at, ${now}),
            lease_until = NULL, lease_token = NULL
        WHERE id = ${id}${heldBy(args.leaseToken)}
        RETURNING id`,
  );
  return !!row;
}

/** Inspect the queue / delivery log (tests, a future admin view). */
export async function listOutbox(
  db: Db,
  filter: { status?: OutboxStatus; kind?: OutboxKind; bookingUid?: string } = {},
): Promise<OutboxRow[]> {
  const conds = [sql`1 = 1`];
  if (filter.status) conds.push(sql`status = ${filter.status}`);
  if (filter.kind) conds.push(sql`kind = ${filter.kind}`);
  if (filter.bookingUid) conds.push(sql`booking_uid = ${filter.bookingUid}`);
  const where = sql.join(conds, sql` AND `);
  const rows = await db.all<Record<string, unknown>>(
    sql`SELECT * FROM outbox WHERE ${where} ORDER BY created_at ASC`,
  );
  return rows.map(mapRow);
}

/** Count rows in a status (readiness/backlog reporting). */
export async function countOutbox(db: Db, status: OutboxStatus): Promise<number> {
  const row = await db.get<{ n: number }>(
    sql`SELECT COUNT(*) AS n FROM outbox WHERE status = ${status}`,
  );
  return Number(row?.n ?? 0);
}
