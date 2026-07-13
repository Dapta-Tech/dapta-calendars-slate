import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  enqueueOutbox,
  deletePendingOutbox,
  getNotificationSettings,
  loadBookingNotificationContext,
  defaultNotificationSetting,
  type BookingNotificationContext,
  type NotificationSetting,
  type Db,
} from '@slate/db';
import {
  BookingNotifier,
  resolveTemplate,
  type BookingNotification,
  type EmailProvider,
  type EmailTemplateKey,
} from '@slate/notifications';
import { DB, EMAIL, NOTIFIER } from './tokens';

/**
 * Thrown by `deliver` when a row must be deliberately NOT sent (e.g. tenant
 * context unrecoverable on a transport that requires it). The worker marks the
 * row `skipped` ONCE with this reason — it never burns the retry schedule.
 */
export class OutboxSkipError extends Error {}

/** The booking emails the outbox can carry. */
export type EmailKind = 'confirmation' | 'pending' | 'cancellation' | 'reschedule' | 'declined' | 'reminder';

/** Default reminder lead times (minutes before start): 24h and 1h. */
export const DEFAULT_REMINDER_LEAD_MINUTES = [24 * 60, 60];

/**
 * Which per-account notification keys a lifecycle event fans out to. Each side
 * is its own message (own toggle, own template, own outbox row) so a host can
 * silence their copies without touching attendee mail — the Zoho model.
 * `declined` keeps a host copy (pre-split parity: the host was CC'd the
 * "Not accepted" mail — a decline done by one team member must still be
 * visible to the organizer's inbox), separately toggleable via host_declined.
 */
const KIND_SIDES: Record<EmailKind, Array<{ key: EmailTemplateKey; audience: 'attendee' | 'host' }>> = {
  confirmation: [
    { key: 'attendee_confirmation', audience: 'attendee' },
    { key: 'host_booked', audience: 'host' },
  ],
  pending: [
    { key: 'attendee_pending', audience: 'attendee' },
    { key: 'host_booked', audience: 'host' },
  ],
  declined: [
    { key: 'attendee_declined', audience: 'attendee' },
    { key: 'host_declined', audience: 'host' },
  ],
  cancellation: [
    { key: 'attendee_cancellation', audience: 'attendee' },
    { key: 'host_cancelled', audience: 'host' },
  ],
  reschedule: [
    { key: 'attendee_reschedule', audience: 'attendee' },
    { key: 'host_rescheduled', audience: 'host' },
  ],
  reminder: [
    { key: 'attendee_reminder', audience: 'attendee' },
    { key: 'host_reminder', audience: 'host' },
  ],
};

/** The notification key a queued email row was enqueued under (deliver-time gate). */
export function emailKeyFor(kind: EmailKind, audience: 'attendee' | 'host'): EmailTemplateKey {
  const side = KIND_SIDES[kind].find((s) => s.audience === audience);
  return (side ?? KIND_SIDES[kind][0]!).key;
}

/**
 * Durable booking emails (B1 / audit DM1). Every lifecycle email is ENQUEUED as
 * an `outbox` row (kind `email`) instead of a fire-and-forget
 * `void notifier.send().catch(()=>undefined)`; the OutboxWorker drains it with
 * retry+backoff, so an SMTP blip or a process restart never silently drops a
 * booking email — it retries and leaves a delivery-log record.
 *
 * Notification settings (Settings → Notifications) are applied HERE:
 *   - Each lifecycle event fans out per side (attendee / host); a side whose
 *     toggle is OFF is not enqueued at all (no misleading delivery-log rows).
 *   - The payload snapshots the resolved template (per-account custom or
 *     shipped default in the host's locale) at enqueue time, so a later
 *     template edit never rewrites queued mail.
 *   - Reminder lead times come from the account's reminder setting; reminders
 *     are ALSO gated at deliver time (long-lived rows — flipping the toggle
 *     OFF must silence already-scheduled reminders).
 *
 * The payload snapshots the fully-resolved `BookingNotification` at enqueue
 * time (correct semantics: an email about "booking created" should reflect the
 * booking as it was then), plus it carries the plaintext manage URL which the
 * caller has but the DB does not (only the token HASH is stored).
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
    // Optional so existing direct constructions (tests, scripts) keep working;
    // absent = a transport that can send without tenant context.
    @Inject(EMAIL) private readonly provider?: EmailProvider,
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
   * outbox row per ENABLED side per lead time, each due at `start − lead` (a
   * FUTURE next_attempt_at so the worker leaves it dormant until then). Lead
   * times come from the account's reminder setting (default 24h + 1h). Leads
   * whose fire time is already in the past are skipped (never send a stale
   * reminder). Never rejects.
   */
  async enqueueReminders(
    uid: string,
    opts: { manageUrl?: string; leadMinutes?: number[]; now?: number } = {},
  ): Promise<void> {
    try {
      const ctx = await loadBookingNotificationContext(this.db, uid);
      if (!ctx) return;
      const settings = await getNotificationSettings(this.db, ctx.accountId);
      const now = opts.now ?? Date.now();
      const startMs = new Date(ctx.startUtc).getTime();
      const leads =
        opts.leadMinutes ??
        settings.get('attendee_reminder')?.reminderLeadMinutes ??
        DEFAULT_REMINDER_LEAD_MINUTES;
      for (const side of KIND_SIDES.reminder) {
        const n = this.sideNotification('reminder', ctx, side, settings, { manageUrl: opts.manageUrl });
        if (!n) continue;
        for (const lead of leads) {
          const fireAt = startMs - lead * 60_000;
          if (fireAt <= now) continue; // too late for this lead — skip, don't spam
          await enqueueOutbox(this.db, {
            kind: 'email',
            action: 'reminder',
            bookingUid: uid,
            accountId: ctx.accountId,
            payload: JSON.stringify({ ...n, reminderLeadMinutes: lead }),
            nextAttemptAt: fireAt,
          });
        }
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
   * Build the notification snapshots from the DB + caller overrides and enqueue
   * one durable email row per ENABLED side. Never throws — a failure to enqueue
   * is logged, so the caller's `void`-ed fire-and-forget never blocks or
   * rejects the booking.
   */
  private async enqueue(
    kind: Exclude<EmailKind, 'reminder'>,
    uid: string,
    extra: { manageUrl?: string; cancellationReason?: string | null; previousStartUtc?: string | null },
  ): Promise<void> {
    try {
      const ctx = await loadBookingNotificationContext(this.db, uid);
      if (!ctx) {
        this.log.warn(`skip ${kind} email — no notification context for booking ${uid}`);
        return;
      }
      const settings = await getNotificationSettings(this.db, ctx.accountId);
      for (const side of KIND_SIDES[kind]) {
        const n = this.sideNotification(kind, ctx, side, settings, extra);
        if (!n) continue;
        await enqueueOutbox(this.db, {
          kind: 'email',
          action: kind,
          bookingUid: uid,
          accountId: ctx.accountId,
          payload: JSON.stringify(n),
        });
      }
    } catch (err) {
      this.log.error(`failed to enqueue ${kind} email for ${uid}: ${String(err)}`);
    }
  }

  /**
   * One side's notification snapshot, or null when it should not be sent:
   * toggle OFF, or the side has no recipient (e.g. a host-less booking).
   */
  private sideNotification(
    kind: EmailKind,
    ctx: BookingNotificationContext,
    side: { key: EmailTemplateKey; audience: 'attendee' | 'host' },
    settings: Map<string, NotificationSetting>,
    extra: { manageUrl?: string; cancellationReason?: string | null; previousStartUtc?: string | null },
  ): BookingNotification | null {
    const setting = settings.get(side.key) ?? defaultNotificationSetting(side.key);
    if (!setting.enabled) {
      this.log.log(`skip ${kind}/${side.key} for ${ctx.uid} — disabled by account settings`);
      return null;
    }
    if (side.audience === 'host' && !ctx.host.email && !ctx.coHosts.some((h) => h.email)) {
      return null; // nobody to notify on the host side
    }
    return {
      ...this.toNotification(ctx, extra),
      audience: side.audience,
      template: resolveTemplate(side.key, setting, ctx.hostLocale),
      templateLocale: ctx.hostLocale,
      pending: kind === 'pending',
    };
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
   *
   * Reminders are re-gated here: their rows can sit for days, so a toggle
   * flipped OFF after scheduling must still silence them (skip = success, the
   * row is marked done — not an error to retry).
   */
  async deliver(kind: string, payloadJson: string, outboxAccountId?: string | null): Promise<void> {
    const n = JSON.parse(payloadJson) as BookingNotification & { reminderLeadMinutes?: number };
    if (!n.accountId && outboxAccountId) n.accountId = outboxAccountId;
    if (!n.accountId && n.uid) {
      const current = await loadBookingNotificationContext(this.db, n.uid);
      if (current) n.accountId = current.accountId;
    }
    if (!n.accountId && this.provider?.requiresAccountContext) {
      // Only the signed http wire actually needs a tenant. Skipping is a
      // DECISION, not a failure — recorded once, never retried (a legacy row
      // can never grow an accountId by waiting).
      throw new OutboxSkipError(
        'email outbox row missing account context — skipped (signed transport requires a tenant)',
      );
    }
    if (kind === 'reminder' && n.accountId) {
      const settings = await getNotificationSettings(this.db, n.accountId);
      const enabledFor = (audience: 'attendee' | 'host') =>
        settings.get(emailKeyFor('reminder', audience))?.enabled ?? true;
      // Legacy audience-less rows mail attendee+host COMBINED: send while
      // EITHER side wants reminders — the attendee toggle must never silence
      // the host (and vice versa). Sided rows check only their own toggle.
      const wanted = n.audience
        ? enabledFor(n.audience)
        : enabledFor('attendee') || enabledFor('host');
      if (!wanted) {
        this.log.log(
          `skip queued reminder (${n.audience ?? 'legacy combined'}) for ${n.uid} — disabled by account settings`,
        );
        return;
      }
    }
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
        await this.notifier.sendReminder(n);
        return;
      default:
        throw new Error(`unknown email kind: ${kind}`);
    }
  }
}
