import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  enqueueOutbox,
  loadBookingNotificationContext,
  type BookingNotificationContext,
  type Db,
} from '@slate/db';
import { BookingNotifier, type BookingNotification } from '@slate/notifications';
import { DB, NOTIFIER } from './tokens';

/** The booking emails the outbox can carry. */
export type EmailKind = 'confirmation' | 'pending' | 'cancellation' | 'reschedule' | 'declined';

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
      uid: ctx.uid,
      title: ctx.title,
      startUtc: ctx.startUtc,
      endUtc: ctx.endUtc,
      host: ctx.host,
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
      default:
        throw new Error(`unknown email kind: ${kind}`);
    }
  }
}
