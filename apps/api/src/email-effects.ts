import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  enqueueOutbox,
  deletePendingOutbox,
  loadBookingNotificationContext,
  type BookingNotificationContext,
  type Db,
} from '@slate/db';
import { BookingNotifier, type BookingNotification } from '@slate/notifications';
import { DB, NOTIFIER } from './tokens';

/** The booking emails the outbox can carry. */
export type EmailKind = 'confirmation' | 'pending' | 'cancellation' | 'reschedule' | 'declined' | 'reminder';

/** Default reminder lead times (minutes before start): 24h and 1h. */
export const DEFAULT_REMINDER_LEAD_MINUTES = [24 * 60, 60];

/**
 * Durable booking emails (B1 / audit DM1). Every lifecycle email is ENQUEUED as
 * an `outbox` row (kind `email`) instead of a fire-and-forget
 * `void notifier.send().catch(()=>undefined)`; the OutboxWorker drains it with
 * retry+backoff, so an SMTP blip or a process restart never silently drops a
 * booking email — it retries and leaves a delivery-log record.
 *
 * The payload snapshots the fully-rendered `BookingNotification` at enqueue time
 * (correct semantics: an email about "booking created" should reflect the
 * booking as it was then), plus it carries the plaintext manage URL which the
 * caller has but the DB does not (only the token HASH is stored). All other
 * fields are loaded from the DB by uid so callers that only have a uid
 * (host cancel/decline/confirm) can enqueue without re-assembling context.
 *
 * Delivery success = `notifier.sendX` RESOLVES. The OSS-default `log-only`
 * provider resolves `{delivered:false}` (a no-op log) — that is still success,
 * so a bare clone does not accumulate failed rows. Only a THROWN transport
 * error (smtp/http) drives a retry.
 */
@Injectable()
export class EmailEffects {
  private readonly log = new Logger('EmailEffects');

  constructor(
    @Inject(NOTIFIER) private readonly notifier: BookingNotifier,
    @Inject(DB) private readonly db: Db,
  ) {}

  // Each returns a promise that NEVER rejects (failures are logged) — callers
  // fire-and-forget with `void`; tests may await to assert the enqueued row.
  enqueueConfirmation(uid: string, opts: { manageUrl?: string } = {}): Promise<void> {
    return this.enqueue('confirmation', uid, opts);
  }
  enqueuePending(uid: string, opts: { manageUrl?: string } = {}): Promise<void> {
    return this.enqueue('pending', uid, opts);
  }
  enqueueCancellation(uid: string, opts: { reason?: string | null } = {}): Promise<void> {
    return this.enqueue('cancellation', uid, { cancellationReason: opts.reason ?? null });
  }
  enqueueReschedule(uid: string, opts: { manageUrl?: string; previousStartUtc?: string | null } = {}): Promise<void> {
    return this.enqueue('reschedule', uid, opts);
  }
  enqueueDeclined(uid: string, opts: { reason?: string | null } = {}): Promise<void> {
    return this.enqueue('declined', uid, { cancellationReason: opts.reason ?? null });
  }

  /**
   * Schedule REMINDER emails for a confirmed booking — one `email`/`reminder`
   * outbox row per lead time, each due at `start − lead` (a FUTURE next_attempt_at
   * so the worker leaves it dormant until then). Leads whose fire time is already
   * in the past are skipped (never send a stale reminder). Never rejects.
   */
  async enqueueReminders(
    uid: string,
    opts: { manageUrl?: string; leadMinutes?: number[]; now?: number } = {},
  ): Promise<void> {
    try {
      const ctx = await loadBookingNotificationContext(this.db, uid);
      if (!ctx) return;
      const now = opts.now ?? Date.now();
      const startMs = new Date(ctx.startUtc).getTime();
      const leads = opts.leadMinutes ?? DEFAULT_REMINDER_LEAD_MINUTES;
      const base = this.toNotification(ctx, { manageUrl: opts.manageUrl });
      for (const lead of leads) {
        const fireAt = startMs - lead * 60_000;
        if (fireAt <= now) continue; // too late for this lead — skip, don't spam
        await enqueueOutbox(this.db, {
          kind: 'email',
          action: 'reminder',
          bookingUid: uid,
          payload: JSON.stringify({ ...base, reminderLeadMinutes: lead }),
          nextAttemptAt: fireAt,
        });
      }
    } catch (err) {
      this.log.error(`failed to schedule reminders for ${uid}: ${String(err)}`);
    }
  }

  /** Drop any still-pending reminders for a booking (on cancel/decline). */
  async cancelReminders(uid: string): Promise<void> {
    try {
      await deletePendingOutbox(this.db, { bookingUid: uid, kind: 'email', action: 'reminder' });
    } catch (err) {
      this.log.error(`failed to cancel reminders for ${uid}: ${String(err)}`);
    }
  }

  /** Reschedule moved the booking → drop the old reminders and re-schedule at the new time. */
  async repointReminders(uid: string, opts: { manageUrl?: string; now?: number } = {}): Promise<void> {
    await this.cancelReminders(uid);
    await this.enqueueReminders(uid, opts);
  }

  /**
   * Build the notification snapshot from the DB + caller overrides and enqueue a
   * durable email row. Never throws — a failure to enqueue is logged, so the
   * caller's `void`-ed fire-and-forget never blocks or rejects the booking.
   */
  private async enqueue(
    kind: EmailKind,
    uid: string,
    extra: { manageUrl?: string; cancellationReason?: string | null; previousStartUtc?: string | null },
  ): Promise<void> {
    try {
      const ctx = await loadBookingNotificationContext(this.db, uid);
      if (!ctx) {
        this.log.warn(`skip ${kind} email — no notification context for booking ${uid}`);
        return;
      }
      const notification = this.toNotification(ctx, extra);
      await enqueueOutbox(this.db, {
        kind: 'email',
        action: kind,
        bookingUid: uid,
        payload: JSON.stringify(notification),
      });
    } catch (err) {
      this.log.error(`failed to enqueue ${kind} email for ${uid}: ${String(err)}`);
    }
  }

  private toNotification(
    ctx: BookingNotificationContext,
    extra: { manageUrl?: string; cancellationReason?: string | null; previousStartUtc?: string | null },
  ): BookingNotification {
    return {
      accountId: ctx.accountId,
      uid: ctx.uid,
      title: ctx.title,
      startUtc: ctx.startUtc,
      endUtc: ctx.endUtc,
      host: ctx.host,
      coHosts: ctx.coHosts,
      attendee: ctx.attendee,
      location: ctx.location,
      manageUrl: extra.manageUrl ?? null,
      cancellationReason: extra.cancellationReason ?? null,
      previousStartUtc: extra.previousStartUtc ?? null,
      // DTSTAMP = the moment the notification was assembled (not the event start).
      stamp: new Date().toISOString(),
    };
  }

  /**
   * The worker's executor for an `email` outbox row. Rebuilds the notification
   * from the payload and sends it via the notifier; a THROWN transport error
   * propagates so the worker retries. `delivered:false` (log-only) is success.
   */
  async deliver(kind: string, payloadJson: string): Promise<void> {
    const n = JSON.parse(payloadJson) as BookingNotification;
    switch (kind) {
      case 'confirmation':
        await this.notifier.sendConfirmation(n);
        return;
      case 'pending':
        await this.notifier.sendPendingRequest(n);
        return;
      case 'cancellation':
        await this.notifier.sendCancellation(n);
        return;
      case 'reschedule':
        await this.notifier.sendReschedule(n);
        return;
      case 'declined':
        await this.notifier.sendDeclined(n);
        return;
      case 'reminder':
        await this.notifier.sendReminder(n as BookingNotification & { reminderLeadMinutes?: number });
        return;
      default:
        throw new Error(`unknown email kind: ${kind}`);
    }
  }
}
