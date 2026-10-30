import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  Optional,
  type OnModuleInit,
} from '@nestjs/common';
import {
  claimDueOutbox,
  DEFAULT_LEASE_MS,
  deliverWebhookEvent,
  loadEncryptionKey,
  markOutboxDone,
  markOutboxFailed,
  markOutboxRetry,
  markOutboxSkipped,
  MAX_BACKOFF_MS,
  outboxRetriesExhausted,
  recordWebhookGaveUp,
  renewOutboxLease,
  retryDelayMs,
  type Db,
  type OutboxKind,
  type OutboxRow,
} from '@slate/db';
import type { ServerEnv } from '@slate/config/env';
import { AnalyticsEffects } from './analytics-effects';
import { CalendarEffects, type CalendarAction } from './calendar-effects';
import { CrmEffects } from './crm-effects';
import { DaptaSyncEffects } from './dapta-sync.effects';
import { EmailEffects, OutboxSkipError } from './email-effects';
import { DB, ENV } from './tokens';

/**
 * The lanes the worker drains, each on its own: a lane has its own delivery
 * slots, so a webhook subscriber that takes ten seconds to answer occupies a
 * webhook slot and nothing else. Emails, calendar writes and CRM writes never
 * queue behind it. `other` takes any kind no lane names, so a row of an
 * unknown kind still fails visibly instead of waiting forever.
 */
export const OUTBOX_LANES: ReadonlyArray<{ name: string; kinds: readonly OutboxKind[] | null }> = [
  { name: 'email', kinds: ['email'] },
  { name: 'calendar', kinds: ['calendar'] },
  { name: 'webhook', kinds: ['webhook'] },
  { name: 'crm', kinds: ['crm'] },
  { name: 'sync', kinds: ['dapta_sync', 'iam_onboarding'] },
  { name: 'analytics', kinds: ['analytics'] },
  { name: 'other', kinds: null },
];

/**
 * Kinds that are best effort: they give up once their own attempt budget is
 * spent, with no retry horizon. A lost product-analytics event is acceptable;
 * retrying one for a day against a vendor that is down is not worth the load.
 */
const NO_RETRY_HORIZON = new Set<string>(['analytics']);
const NAMED_KINDS = OUTBOX_LANES.flatMap((l) => l.kinds ?? []);

/** A duration for a log line: "45s", "12m", "3h". */
function span(ms: number): string {
  if (ms < 120_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 7_200_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

/**
 * The OUTBOX WORKER (B7 / audit DM1). Drains the `outbox` table, executing each
 * durable side-effect and retrying it until it succeeds or its retries end.
 * This is what turns fire-and-forget calendar/webhook/email calls into
 * no-silent-loss delivery.
 *
 *   - Lanes: each kind of work drains on its own (`OUTBOX_LANES`), with up to
 *     `OUTBOX_CONCURRENCY` deliveries in flight per lane. Rows that share an
 *     order key (a booking's calendar writes; one side's mail about a booking;
 *     a subscriber's events about a booking) go one at a time, in the order
 *     queued, a row backing off holding the rows behind it, and a webhook
 *     subscriber holds at most one slot per process. A slow or failing
 *     destination therefore delays only its own deliveries, and a retry never
 *     lets a delete or a "cancelled" overtake what it follows.
 *   - Claims are leased (`claimDueOutbox`), so several API replicas can run
 *     this worker against one database without delivering a row twice; a
 *     replica that dies mid-delivery has its rows picked up when the lease
 *     runs out. A delivery still running renews its lease.
 *   - Success: the row is marked `done`.
 *   - Failure: attempts++ and the row is due again after an exponential,
 *     jittered backoff counted from the failure itself (1s, 2s, 4s ... capped
 *     at 15 min). Once it has spent its attempt budget AND been failing for
 *     `OUTBOX_RETRY_HORIZON_MS` (default 24 h) it is marked `failed` and
 *     logged; a webhook's give-up also lands in the host's delivery log.
 *   - Idempotent: calendar write-out is guarded by the DH1 claim, and a
 *     webhook carries the same body, signature and `X-Slate-Delivery` id on
 *     every attempt.
 *
 * The poll loop starts on module init (unless disabled or under `NODE_ENV=test`)
 * and stops on destroy. `drainOnce` is public so tests can pump the queue
 * deterministically without waiting on the interval; `fetchImpl` is swappable
 * for webhook-delivery tests.
 */
@Injectable()
export class OutboxWorker implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('OutboxWorker');
  private timer: ReturnType<typeof setInterval> | null = null;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private wakeAt = Number.POSITIVE_INFINITY;
  private stopped = false;
  /** Deliveries in flight per lane, and the lanes whose claim is running. */
  private readonly inFlight = new Map<string, number>();
  private readonly claiming = new Set<string>();
  /** Lanes asked to claim while their claim was running: claim again after it. */
  private readonly again = new Set<string>();
  /** Injectable for tests; defaults to global fetch for webhook delivery. */
  fetchImpl: typeof fetch = fetch;
  /** The clock the poll loop reads; a field so specs can move it. */
  now: () => number = Date.now;
  /** The jitter source for retry delays; a field so specs can pin it. */
  random: () => number = Math.random;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: ServerEnv,
    // Explicit tokens: esbuild/tsx elides type-only imports, so relying on
    // reflected metadata for these class deps injects `undefined`. @Inject keeps
    // the class a value and gives Nest the token directly.
    @Inject(CalendarEffects) private readonly calendar: CalendarEffects,
    @Inject(EmailEffects) private readonly email: EmailEffects,
    @Inject(DaptaSyncEffects) private readonly daptaSync: DaptaSyncEffects,
    // H1a. LAST and @Optional() for the same reason as the lifecycle services:
    // the existing worker specs construct this positionally, and a worker with
    // no CRM handler simply has no `crm` rows to drain.
    @Optional() @Inject(CrmEffects) private readonly crm?: CrmEffects,
    // Product analytics. Optional and last for the same reason as the CRM: a
    // worker built without it has no `analytics` rows to drain, because
    // nothing enqueues them when analytics is off.
    @Optional() @Inject(AnalyticsEffects) private readonly analytics?: AnalyticsEffects,
  ) {}

  private get concurrency(): number {
    return Math.max(1, this.env.OUTBOX_CONCURRENCY ?? 4);
  }

  private get leaseMs(): number {
    return this.env.OUTBOX_LEASE_MS ?? DEFAULT_LEASE_MS;
  }

  private get horizonMs(): number {
    return this.env.OUTBOX_RETRY_HORIZON_MS ?? 24 * 3_600_000;
  }

  /**
   * The webhook signing key (#75), resolved once and cached — including the
   * "no key" answer, which is a normal state for a deployment whose webhook
   * secrets are all legacy plaintext. Cached because the worker asks per
   * delivery and the answer cannot change without a restart.
   */
  private cachedWebhookKey: Buffer | null | undefined;
  private webhookKey(): Buffer | null {
    if (this.cachedWebhookKey === undefined) {
      try {
        this.cachedWebhookKey = loadEncryptionKey(this.env.INTEGRATION_ENCRYPTION_KEY);
      } catch (err) {
        this.cachedWebhookKey = null;
        // Warned ONCE, at the moment the answer is decided. A key that is set
        // but malformed is the state that otherwise hides: legacy plaintext
        // rows keep signing and nothing is ever re-sealed, so without this line
        // the deployment looks healthy while quietly doing nothing it was
        // configured to do. The message names the variable, never a secret.
        if (this.env.INTEGRATION_ENCRYPTION_KEY) {
          this.log.warn(
            `webhook signing key unusable, encrypted secrets cannot be opened: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    }
    return this.cachedWebhookKey;
  }

  onModuleInit(): void {
    if (!this.env.OUTBOX_WORKER_ENABLED || this.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => {
      void this.pump();
    }, this.env.OUTBOX_POLL_MS);
    // Don't keep the process alive solely for the poll loop.
    this.timer.unref?.();
    this.log.log(
      `outbox worker started (poll ${this.env.OUTBOX_POLL_MS}ms, ${this.concurrency} per lane, ` +
        `retry horizon ${span(this.horizonMs)})`,
    );
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.timer = null;
    this.wakeTimer = null;
  }

  /**
   * One poll tick: every lane with a free slot claims what it can take and
   * starts it. Resolves once the claims are made, NOT when the deliveries end
   * (that is `drainOnce`). Public so specs can drive the live path.
   */
  async pump(): Promise<void> {
    if (this.stopped) return;
    await Promise.all(OUTBOX_LANES.map((lane) => this.pumpLane(lane)));
  }

  /**
   * Fill a lane's free slots. Never awaits the deliveries it starts: a slow
   * one holds its own slot, not the poll loop, so the next tick still claims
   * for every other lane (and for this one, if it has room).
   */
  private async pumpLane(lane: (typeof OUTBOX_LANES)[number]): Promise<void> {
    if (this.stopped) return;
    if (this.claiming.has(lane.name)) {
      this.again.add(lane.name);
      return;
    }
    const free = this.concurrency - (this.inFlight.get(lane.name) ?? 0);
    if (free <= 0) return;
    this.claiming.add(lane.name);
    let rows: OutboxRow[] = [];
    try {
      rows = await claimDueOutbox(this.db, this.now(), free, this.claimOptions(lane));
    } catch (err) {
      this.log.error(`outbox claim failed (${lane.name}): ${String(err)}`);
    } finally {
      this.claiming.delete(lane.name);
    }
    for (const row of rows) {
      this.inFlight.set(lane.name, (this.inFlight.get(lane.name) ?? 0) + 1);
      void this.process(row, this.now).finally(() => {
        this.inFlight.set(lane.name, Math.max(0, (this.inFlight.get(lane.name) ?? 1) - 1));
        // A slot just freed, and the destination it served may have more
        // waiting: look now rather than at the next poll, so a healthy
        // subscriber's backlog drains back to back.
        void this.pumpLane(lane);
      });
    }
    if (this.again.delete(lane.name)) void this.pumpLane(lane);
  }

  private claimOptions(lane: (typeof OUTBOX_LANES)[number]) {
    return {
      ...(lane.kinds ? { kinds: lane.kinds } : { excludeKinds: NAMED_KINDS }),
      leaseMs: this.leaseMs,
      inOrder: true,
    };
  }

  /**
   * A retry is due before the next poll: tick then, so a 1 s backoff is 1 s,
   * not "whenever the poll comes round". Only while the poll loop runs.
   */
  private wake(at: number): void {
    if (!this.timer || this.stopped || at >= this.wakeAt) return;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeAt = at;
    this.wakeTimer = setTimeout(
      () => {
        this.wakeTimer = null;
        this.wakeAt = Number.POSITIVE_INFINITY;
        void this.pump();
      },
      Math.max(0, at - this.now()),
    );
    this.wakeTimer.unref?.();
  }

  /**
   * Process every currently-due row, lane by lane, and wait for all of it.
   * Returns the number of rows processed (attempted), regardless of success.
   *
   * With `at`, time stands still at that instant for the whole drain (claims,
   * leases, and every retry's schedule), which is what makes the specs
   * deterministic. Rows a destination had to wait for are taken in further
   * rounds of the same drain; a row that failed is due again only in the
   * future, so the drain always ends.
   */
  async drainOnce(at?: number): Promise<number> {
    const clock = at === undefined ? this.now : () => at;
    let total = 0;
    for (let round = 0; round < 100; round++) {
      const counts = await Promise.all(
        OUTBOX_LANES.map(async (lane) => {
          const rows = await claimDueOutbox(this.db, clock(), 50, this.claimOptions(lane));
          let next = 0;
          const slot = async (): Promise<void> => {
            while (next < rows.length) await this.process(rows[next++]!, clock);
          };
          await Promise.all(Array.from({ length: Math.min(this.concurrency, rows.length) }, slot));
          return rows.length;
        }),
      );
      const n = counts.reduce((a, b) => a + b, 0);
      total += n;
      if (n === 0) break;
    }
    return total;
  }

  private async process(row: OutboxRow, clock: () => number): Promise<void> {
    // Keep the claim while the delivery runs, however long it takes, so no
    // other worker starts the same row meanwhile.
    const renew = row.leaseToken
      ? setInterval(
          () => {
            void renewOutboxLease(this.db, row.id, row.leaseToken!, this.now() + this.leaseMs).catch(
              () => undefined,
            );
          },
          Math.max(1000, Math.floor(this.leaseMs / 3)),
        )
      : null;
    renew?.unref?.();
    try {
      await this.execute(row);
      clearInterval(renew ?? undefined);
      const written = await markOutboxDone(this.db, row.id, clock(), row.leaseToken);
      if (!written) {
        // Its lease passed to another worker (a delivery slower than the
        // lease), or the row was removed meanwhile (a reminder dropped by a
        // cancel). The delivery happened; only this record of it did not land.
        this.log.warn(`outbox ${row.kind}:${row.action} (${row.id}) delivered, but the row was taken over or removed meanwhile`);
      }
    } catch (err) {
      clearInterval(renew ?? undefined);
      try {
        await this.recordFailure(row, err, clock);
      } catch (writeErr) {
        // The row keeps its lease and is retried once it runs out.
        this.log.error(`outbox ${row.kind}:${row.action} (${row.id}) outcome not recorded: ${String(writeErr)}`);
      }
    }
  }

  private async recordFailure(row: OutboxRow, err: unknown, clock: () => number): Promise<void> {
    const now = clock();
    if (err instanceof OutboxSkipError) {
      // A decision, not a failure: record the reason ONCE and stop: waiting
      // and retrying cannot change the outcome.
      const skipped = await markOutboxSkipped(this.db, row.id, { reason: err.message, now, leaseToken: row.leaseToken });
      this.log.warn(`outbox ${row.kind}:${row.action} (${row.id}) skipped: ${err.message}`);
      if (skipped) await this.afterGaveUp(row);
      return;
    }
    const attempts = row.attempts + 1;
    const message = err instanceof Error ? err.message : String(err);
    const horizonMs = NO_RETRY_HORIZON.has(row.kind) ? 0 : this.horizonMs;
    if (outboxRetriesExhausted(row, attempts, now, horizonMs)) {
      const failed = await markOutboxFailed(this.db, row.id, { attempts, error: message, now, leaseToken: row.leaseToken });
      const tried = row.firstFailedAt == null ? '' : ` over ${span(now - row.firstFailedAt)}`;
      this.log.error(
        `outbox ${row.kind}:${row.action} (${row.id}) failed for good after ${attempts} attempts${tried}: ${message}`,
      );
      if (row.kind === 'webhook' && row.webhookId && row.payload != null) {
        await recordWebhookGaveUp(this.db, { webhookId: row.webhookId, body: row.payload, attempts }).catch(
          () => undefined,
        );
      }
      if (failed) await this.afterGaveUp(row);
      return;
    }
    // A failure that names its own wait (a calendar backend's Retry-After,
    // the conferencing-link look) is not asked again sooner than that.
    const floor = (err as { retryAfterMs?: unknown } | null)?.retryAfterMs;
    const delayMs = Math.max(
      retryDelayMs(attempts, this.random),
      typeof floor === 'number' && floor > 0 ? Math.min(floor, MAX_BACKOFF_MS) : 0,
    );
    await markOutboxRetry(this.db, row.id, { attempts, error: message, now, delayMs, leaseToken: row.leaseToken });
    this.log.warn(
      `outbox ${row.kind}:${row.action} (${row.id}) failed (attempt ${attempts}), next try in ${span(delayMs)}: ${message}`,
    );
    this.wake(now + delayMs);
  }

  /**
   * A row that ended unsent. An invitee email that never went out may leave a
   * calendar change that counted on it without the provider's invitation, so
   * the email side gets to queue the provider's invitation after all. Never
   * throws.
   */
  private async afterGaveUp(row: OutboxRow): Promise<void> {
    if (row.kind !== 'email') return;
    try {
      // Optional: a worker built in a spec with a bare email stub has none.
      await this.email.afterGaveUp?.(row);
    } catch {
      // Logged by the email side; the row's own outcome is already written.
    }
  }

  /** Perform the row's side-effect. Throws on failure so `process` can retry. */
  private async execute(row: OutboxRow): Promise<void> {
    if (row.kind === 'calendar') {
      if (!row.bookingUid) throw new Error('calendar outbox row missing booking_uid');
      await this.calendar.runCalendarJob(row.action as CalendarAction, row.bookingUid, row.payload, {
        id: row.id,
        attempts: row.attempts,
      });
      return;
    }
    // H1a (#63): ONE row does both halves of the CRM write-out — resolve the
    // contact, then create the meeting associated to it. Retries are safe: the
    // DH1 claim on `booking_reference` means a re-run cannot create a second
    // meeting.
    if (row.kind === 'crm') {
      if (!row.bookingUid) throw new Error('crm outbox row missing booking_uid');
      if (!this.crm) throw new Error('crm outbox row with no CRM handler wired');
      await this.crm.runCrmJob(row.action, row.bookingUid);
      return;
    }
    if (row.kind === 'webhook') {
      if (!row.webhookId || row.payload == null)
        throw new Error('webhook outbox row missing webhook_id/payload');
      await deliverWebhookEvent(
        this.db,
        {
          webhookId: row.webhookId,
          body: row.payload,
          // The row id: the same on every retry of this event to this subscriber.
          deliveryId: row.id,
          // #75: null is a valid state (a deployment with only legacy plaintext
          // secrets). An ENCRYPTED secret with no key throws inside, which the
          // catch below turns into a normal retry — so a key removed by mistake
          // shows up as retrying deliveries, never as unsigned ones.
          key: this.webhookKey(),
        },
        this.fetchImpl,
      );
      return;
    }
    if (row.kind === 'email') {
      if (row.payload == null) throw new Error('email outbox row missing payload');
      // `attempts` bounds the conferencing-link wait (ADR 0007): the delivery
      // side needs to know how long it has already waited to decide when to
      // stop waiting and send the mail without the link.
      await this.email.deliver(row.action, row.payload, row.accountId, row.attempts);
      return;
    }
    // O2 growth (#94). Two kinds, never one: the contact upsert and the
    // lead-score post retry independently, so a CRM outage can never re-post
    // the qualification responses and mint a second lead score.
    if (row.kind === 'dapta_sync') {
      await this.daptaSync.deliverContact(row.action, row.payload);
      return;
    }
    if (row.kind === 'iam_onboarding') {
      await this.daptaSync.deliverLeadScore(row.action, row.payload);
      return;
    }
    if (row.kind === 'analytics') {
      if (!this.analytics) throw new OutboxSkipError('analytics is not configured');
      await this.analytics.deliver(row.action, row.payload);
      return;
    }
    throw new Error(`unknown outbox kind: ${String(row.kind)}`);
  }
}
