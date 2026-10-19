import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  enqueueOutbox,
  deletePendingOutbox,
  DEFAULT_MAX_ATTEMPTS,
  hasPendingCalendarJob,
  getNotificationSettings,
  loadBookingMeetingUrl,
  loadBookingNotificationContext,
  defaultNotificationSetting,
  type BookingNotificationContext,
  type EventReminder,
  type NotificationSetting,
  sql,
  type Db,
} from '@slate/db';
import {
  BookingNotifier,
  HOST_DETAIL_KINDS,
  MAX_ANSWER_ITEMS,
  collectBookingAnswers,
  defaultEnabledFor,
  extractTokens,
  resolveTemplate,
  type BookingNotification,
  type EmailProvider,
  type EmailTemplateKey,
} from '@slate/notifications';
import { MAX_TEMPLATE_VALUE } from '@slate/engine';
import { adminBookingPath, formatBookingLocation, getMessages } from '@slate/shared';
import type { ServerEnv } from '@slate/config/env';
import type { CalendarProvider } from '@slate/calendar';
import { CALENDAR, DB, EMAIL, ENTITLEMENT_GATE, ENTITLEMENTS, ENV, NOTIFIER, PREMIUM_MODE } from './tokens';
import { DisabledEntitlementsProvider, type EntitlementsProvider } from './entitlements.provider';
import { EntitlementGate } from './entitlement-gate';

/**
 * Thrown by `deliver` when a row must be deliberately NOT sent (e.g. tenant
 * context unrecoverable on a transport that requires it). The worker marks the
 * row `skipped` ONCE with this reason — it never burns the retry schedule.
 */
export class OutboxSkipError extends Error {}

/**
 * Thrown by `deliver` while a conferencing booking's link has not been minted
 * yet and the bounded wait still has room (ADR 0007). Deliberately a RETRYABLE
 * error, not an `OutboxSkipError`: the worker's normal failure path backs it off
 * and tries again, and the row's `last_error` then names the wait so nobody
 * reading the delivery log mistakes it for a transport fault.
 */
/**
 * The least wait between two looks for a conferencing link, so the bounded
 * wait (CONFERENCING_LINK_WAIT_ATTEMPTS looks) gives the calendar about as
 * long to mint the room as it had when retries rode the 5 s poll.
 */
export const CONFERENCING_LINK_RETRY_MS = 5_000;

export class ConferencingLinkPendingError extends Error {
  /** The worker waits at least this long before the next look. */
  readonly retryAfterMs = CONFERENCING_LINK_RETRY_MS;
}

/**
 * Mail that only makes sense while the booking is on. Once it is cancelled or
 * declined, a row of one of these that is still queued (a retry can wait
 * hours) is skipped rather than sent: a "confirmed" landing after "cancelled"
 * tells the invitee the opposite of the truth.
 */
const LIVE_BOOKING_KINDS = new Set(['confirmation', 'reschedule', 'reminder', 'follow_up']);

/**
 * One side's mail about one booking goes out in the order it was queued
 * (confirmed, moved, cancelled), however long a retry waits. The two sides are
 * ordered apart: an invitee address the mail transport refuses must not hold
 * up the host's copies.
 */
function emailOrderKey(uid: string, audience: 'attendee' | 'host'): string {
  return `${uid}|${audience}`;
}

/**
 * How late a conferencing booking's confirmation/reschedule row is first made
 * due, so the calendar row that mints the link gets a head start (ADR 0007).
 * Three ticks of the default `OUTBOX_POLL_MS` (5000) — the realistic floor for
 * "the calendar row has been drained".
 */
export const CONFERENCING_LINK_GRACE_MS = 15_000;

/**
 * How many attempts a conferencing row waits for its link before sending
 * WITHOUT it.
 *
 * A waiting row does NOT spend the transport's retry budget: link-aware rows are
 * enqueued with `DEFAULT_MAX_ATTEMPTS + CONFERENCING_LINK_WAIT_ATTEMPTS`, so
 * after the wait is spent a conferencing email still has the same five attempts
 * at the mail transport that every other email gets. Sharing one counter would
 * quietly leave conferencing confirmations with two.
 */
export const CONFERENCING_LINK_WAIT_ATTEMPTS = 3;

/**
 * The email kinds that wait for a link. Reminders and follow-ups are scheduled
 * far in the future — by the time they fire the link exists or never will, so
 * waiting would burn attempts for nothing (they still read it FRESH, which is
 * what makes a late link show up in them). `pending` never waits: the booking
 * is not accepted, so no calendar row exists to wait for. Cancellations and
 * declines carry no join line at all.
 */
const LINK_AWARE_KINDS = new Set(['confirmation', 'reschedule']);

/** The booking emails the outbox can carry. */
export type EmailKind =
  | 'confirmation'
  | 'pending'
  | 'cancellation'
  | 'reschedule'
  | 'declined'
  | 'reminder'
  | 'follow_up';

/**
 * Reminder timing no longer lives here. The shipped 24h + 1h leads and the 1h
 * follow-up moved to `@slate/db`'s `reminders` module, beside the storage that
 * pre-fills a new event type with them (#68) — one definition of what a host
 * gets by default, read by the enqueue path through the booking's event type.
 */

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
  // Post-meeting thank-you — attendee only, strictly opt-in (default OFF).
  follow_up: [{ key: 'follow_up', audience: 'attendee' }],
};

/** The notification key a queued email row was enqueued under (deliver-time gate). */
export function emailKeyFor(kind: EmailKind, audience: 'attendee' | 'host'): EmailTemplateKey {
  const side = KIND_SIDES[kind].find((s) => s.audience === audience);
  return (side ?? KIND_SIDES[kind][0]!).key;
}

/**
 * The answers `{{form.*}}` may quote: only the event's own questions, each
 * capped to what a template would print anyway. The public booking request
 * accepts any answer key, so one the event never asked must not ride into
 * mail sent under the host's name; dropping it also keeps payloads small.
 */
function declaredAnswers(ctx: BookingNotificationContext): Record<string, unknown> | null {
  if (!ctx.formAnswers) return null;
  const out: Record<string, unknown> = {};
  for (const field of ctx.bookingFields) {
    if (!Object.hasOwn(ctx.formAnswers, field.name)) continue;
    const value = ctx.formAnswers[field.name];
    out[field.name] =
      typeof value === 'string'
        ? value.slice(0, MAX_TEMPLATE_VALUE.text)
        : Array.isArray(value)
          ? value.slice(0, MAX_ANSWER_ITEMS).map((v) => (typeof v === 'string' ? v.slice(0, MAX_TEMPLATE_VALUE.text) : v))
          : value;
  }
  return out;
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
 *     shipped default) at enqueue time, so a later template edit never
 *     rewrites queued mail. Each side reads in its own language: the
 *     invitee's copies in the one they booked in (`booking.locale`), the
 *     host's in the host's; a booking with no recorded language keeps the
 *     invitee's copies in the host's, as before.
 *   - The host's side also snapshots who the booking is from and what they
 *     answered, and the dashboard link the host acts from.
 *   - Reminders and the follow-up are the exception: they come from the EVENT
 *     TYPE (#68), one outbox row per enabled reminder per side, and are ALSO
 *     gated at deliver time by that reminder's own id (long-lived rows — a
 *     reminder switched off or deleted must silence what it scheduled).
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
    // Optional: only needed to compose the public {{booking_link}} URL.
    @Inject(ENV) private readonly env?: ServerEnv,
    // Read for ONE bit: whether a calendar write-out exists at all, which is
    // what decides if a conferencing booking's mail is worth delaying. The PORT
    // interface only (invariant 7) — no adapter, no vendor.
    @Inject(CALENDAR) private readonly calendar?: CalendarProvider,
    // Whether the invitee's mail carries the Dapta branding reads the cached
    // Dapta AI verdict through these, exactly as the public pages do. Optional
    // and last so positional constructions keep working: absent, it is the OSS
    // default (no upstream, `open`).
    @Optional() @Inject(ENTITLEMENTS) private readonly entitlements: EntitlementsProvider = new DisabledEntitlementsProvider(),
    @Optional() @Inject(PREMIUM_MODE) private readonly premiumMode: 'open' | 'locked' = 'open',
    // The app's ONE gate (ENTITLEMENT_GATE), shared with every other service so
    // one refresh per account holds app-wide. Absent (a direct construction),
    // the service builds its own from the two values above.
    @Optional() @Inject(ENTITLEMENT_GATE) private readonly sharedGate?: EntitlementGate,
  ) {}

  private _gate?: EntitlementGate;
  private get gate(): EntitlementGate {
    this._gate ??= this.sharedGate ?? new EntitlementGate(this.db, this.entitlements, this.premiumMode);
    return this._gate;
  }

  // Each returns a promise that NEVER rejects (failures are logged) — callers
  // fire-and-forget with `void`; tests may await to assert the enqueued row.
  enqueueConfirmation(uid: string, opts: { manageUrl?: string } = {}): Promise<void> {
    return this.enqueue('confirmation', uid, opts);
  }
  enqueuePending(uid: string, opts: { manageUrl?: string } = {}): Promise<void> {
    return this.enqueue('pending', uid, opts);
  }
  async enqueueCancellation(uid: string, opts: { reason?: string | null } = {}): Promise<void> {
    await this.dropUnsentLifecycleMail(uid);
    return this.enqueue('cancellation', uid, { cancellationReason: opts.reason ?? null });
  }
  enqueueReschedule(uid: string, opts: { manageUrl?: string; previousStartUtc?: string | null } = {}): Promise<void> {
    return this.enqueue('reschedule', uid, opts);
  }
  async enqueueDeclined(uid: string, opts: { reason?: string | null } = {}): Promise<void> {
    await this.dropUnsentLifecycleMail(uid);
    return this.enqueue('declined', uid, { cancellationReason: opts.reason ?? null });
  }

  /**
   * Schedule REMINDER emails for a confirmed booking — one `email`/`reminder`
   * outbox row per side per ENABLED reminder on the booking's EVENT TYPE (#68),
   * each due at `start − lead` (a FUTURE next_attempt_at so the worker leaves
   * it dormant until then). A booking with no event type falls back to the
   * shipped 24h + 1h. Leads whose fire time is already in the past are skipped
   * (never send a stale reminder). Never rejects.
   */
  async enqueueReminders(
    uid: string,
    opts: { manageUrl?: string; now?: number } = {},
  ): Promise<void> {
    try {
      const ctx = await loadBookingNotificationContext(this.db, uid);
      if (!ctx) return;
      const settings = await getNotificationSettings(this.db, ctx.accountId);
      const now = opts.now ?? Date.now();
      const startMs = new Date(ctx.startUtc).getTime();
      // Each ENABLED reminder on the EVENT TYPE is its own row: its own lead,
      // its own copy, its own id.
      const rows = ctx.reminders.filter((r) => r.kind === 'reminder' && r.enabled);
      for (const side of KIND_SIDES.reminder) {
        for (const row of rows) {
          const n = this.sideNotification('reminder', ctx, side, settings, { manageUrl: opts.manageUrl }, row);
          if (!n) continue;
          const fireAt = startMs - row.leadMinutes * 60_000;
          if (fireAt <= now) continue; // too late for this lead — skip, don't spam
          await enqueueOutbox(this.db, {
            kind: 'email',
            action: 'reminder',
            bookingUid: uid,
            orderKey: emailOrderKey(uid, side.audience),
            accountId: ctx.accountId,
            payload: JSON.stringify({ ...n, reminderLeadMinutes: row.leadMinutes, reminderId: row.id }),
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

  /**
   * Drop a confirmation/reschedule row still sitting in its conferencing grace,
   * because the booking is now off.
   *
   * Those rows used to leave within one poll tick, so a cancellation could never
   * overtake them; with a deliberate delay in front of them it can, and the
   * invitee would read "Cancelled" and then "Confirmed". A booking that is
   * already cancelled should not announce itself as confirmed at all.
   *
   * Deliberately NOT folded into `cancelReminders`: a reschedule calls that one
   * (via `repointReminders`) and must keep the reschedule mail it just queued.
   */
  private async dropUnsentLifecycleMail(uid: string): Promise<void> {
    try {
      for (const action of ['confirmation', 'reschedule']) {
        await deletePendingOutbox(this.db, { bookingUid: uid, kind: 'email', action });
      }
    } catch (err) {
      this.log.error(`failed to drop unsent lifecycle mail for ${uid}: ${String(err)}`);
    }
  }

  /** Reschedule moved the booking → drop the old reminders and re-schedule at the new time. */
  async repointReminders(uid: string, opts: { manageUrl?: string; now?: number } = {}): Promise<void> {
    await this.cancelReminders(uid);
    await this.enqueueReminders(uid, opts);
  }

  /**
   * Schedule the post-meeting FOLLOW-UP — one `email`/`follow_up` outbox row
   * per lead time, each due at `end + lead` (future next_attempt_at, worker
   * leaves it dormant). Mirrors the reminders pattern exactly, except the
   * toggle defaults OFF (opt-in) and it is attendee-side only. Fire times
   * already in the past are skipped. Never rejects.
   */
  async enqueueFollowUps(
    uid: string,
    opts: { manageUrl?: string; now?: number } = {},
  ): Promise<void> {
    try {
      const ctx = await loadBookingNotificationContext(this.db, uid);
      if (!ctx) return;
      const settings = await getNotificationSettings(this.db, ctx.accountId);
      const now = opts.now ?? Date.now();
      const endMs = new Date(ctx.endUtc).getTime();
      // The event type carries at most one follow-up row, off unless the host
      // turned it on (#68 decision 5).
      const stored = ctx.reminders.find((r) => r.kind === 'follow_up');
      const rows = stored && stored.enabled ? [stored] : [];
      for (const side of KIND_SIDES.follow_up) {
        for (const row of rows) {
          const n = this.sideNotification('follow_up', ctx, side, settings, { manageUrl: opts.manageUrl }, row);
          if (!n) continue;
          const fireAt = endMs + row.leadMinutes * 60_000;
          if (fireAt <= now) continue; // meeting long over — never send stale thanks
          await enqueueOutbox(this.db, {
            kind: 'email',
            action: 'follow_up',
            bookingUid: uid,
            orderKey: emailOrderKey(uid, side.audience),
            accountId: ctx.accountId,
            payload: JSON.stringify({ ...n, reminderLeadMinutes: row.leadMinutes, reminderId: row.id }),
            nextAttemptAt: fireAt,
          });
        }
      }
    } catch (err) {
      this.log.error(`failed to schedule follow-up for ${uid}: ${String(err)}`);
    }
  }

  /** Drop any still-pending follow-ups for a booking (on cancel/decline). */
  async cancelFollowUps(uid: string): Promise<void> {
    try {
      await deletePendingOutbox(this.db, { bookingUid: uid, kind: 'email', action: 'follow_up' });
    } catch (err) {
      this.log.error(`failed to cancel follow-up for ${uid}: ${String(err)}`);
    }
  }

  /** Reschedule moved the booking → re-point the follow-up at the new end time. */
  async repointFollowUps(uid: string, opts: { manageUrl?: string; now?: number } = {}): Promise<void> {
    await this.cancelFollowUps(uid);
    await this.enqueueFollowUps(uid, opts);
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
      // ADR 0007: a conferencing booking's mail is made due slightly LATE, so
      // the calendar row that mints the link gets a head start. Every other
      // booking is due immediately — the wait must never tax a booking that
      // will never have a link, which is why a disabled calendar (the OSS
      // default, where NO calendar row is ever enqueued) is excluded here
      // rather than discovered three failed attempts later.
      const waitsForLink =
        LINK_AWARE_KINDS.has(kind) &&
        ctx.locationKind === 'conferencing' &&
        this.calendar?.enabled === true;
      // The grace must outlast a poll tick, or it expires before the worker
      // has looked at the calendar row even once.
      const graceMs = Math.max(CONFERENCING_LINK_GRACE_MS, (this.env?.OUTBOX_POLL_MS ?? 0) * 3);
      for (const side of KIND_SIDES[kind]) {
        const n = this.sideNotification(kind, ctx, side, settings, extra);
        if (!n) continue;
        await enqueueOutbox(this.db, {
          kind: 'email',
          action: kind,
          bookingUid: uid,
          orderKey: emailOrderKey(uid, side.audience),
          accountId: ctx.accountId,
          payload: JSON.stringify(n),
          ...(waitsForLink
            ? {
                nextAttemptAt: Date.now() + graceMs,
                // The wait gets its OWN budget on top of the transport's.
                maxAttempts: DEFAULT_MAX_ATTEMPTS + CONFERENCING_LINK_WAIT_ATTEMPTS,
              }
            : {}),
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
    // Present for reminder / follow_up: the EVENT TYPE's row, which owns the
    // switch, the lead and the copy for both sides (#68).
    reminder?: EventReminder,
  ): BookingNotification | null {
    if (reminder) {
      if (!reminder.enabled) return null;
      // The reminder row is the switch (#68 decision 6) — with ONE exception it
      // would be wrong to drop. `host_reminder` used to be independently
      // toggleable, and a host who muted their own copies must not start
      // receiving them again because the setting moved. The stored account key
      // survives as a legacy MUTE on the host side only: it can silence, never
      // enable, and an account that never touched it (the overwhelming default)
      // is unaffected.
      if (side.audience === 'host' && settings.get('host_reminder')?.enabled === false) {
        this.log.log(`skip ${kind}/host for ${ctx.uid} — host copies muted on the account`);
        return null;
      }
    } else {
      const setting =
        settings.get(side.key) ??
        { ...defaultNotificationSetting(side.key), enabled: defaultEnabledFor(side.key) };
      if (!setting.enabled) {
        this.log.log(`skip ${kind}/${side.key} for ${ctx.uid} — disabled by account settings`);
        return null;
      }
    }
    if (side.audience === 'host' && !ctx.host.email && !ctx.coHosts.some((h) => h.email)) {
      return null; // nobody to notify on the host side
    }
    const setting = reminder
      ? // The row's subject/body are the INVITEE copy. The host copy renders the
        // shipped `host_reminder` default in the host's locale, at the same lead
        // and under the same switch: one text cannot serve both sides, and the
        // host template says "with {{attendee_name}}", which is the wrong mail
        // to send an invitee.
        side.audience === 'attendee'
        ? { subject: reminder.subject, body: reminder.body }
        : null
      : (settings.get(side.key) ?? defaultNotificationSetting(side.key));
    // F6: each side reads in its own language. The invitee's copies follow the
    // language they booked in; a booking that never recorded one (every booking
    // before `booking.locale`, an API write naming none) keeps the host's, which
    // is what it always got. The host's copies always keep the host's.
    //
    // Copy the host wrote themselves (an account template, an event reminder's
    // text) is in ONE language, the host's, and is sent as written. A message
    // around it in the visitor's language would mix the two (an English subject
    // with Spanish dates over a Spanish body), so such a copy keeps the host's
    // language whole, exactly as it did before.
    const customCopy = setting != null && (setting.subject != null || setting.body != null);
    const locale =
      side.audience === 'attendee' && !customCopy ? (ctx.attendeeLocale ?? ctx.hostLocale) : ctx.hostLocale;
    const template = resolveTemplate(side.key, setting, locale);
    const reads = new Set(extractTokens(`${template.subject}\n${template.body}`));
    return {
      ...this.toNotification(ctx, extra, locale, reads),
      // The other people on the booking are the host's to read, never an
      // invitee's: on a group event they are strangers to each other.
      ...(side.audience === 'host' && reads.has('guests') ? { guests: ctx.guests } : {}),
      // The manage link is the invitee's tokenised link to THEIR booking; the
      // host's copy is never handed it, so no host mail can carry it.
      ...(side.audience === 'host' ? { manageUrl: null, ...this.hostSide(ctx, kind) } : {}),
      audience: side.audience,
      template,
      templateLocale: locale,
      pending: kind === 'pending',
      // `{{form.*}}` resolves in every email. An account-wide template cannot
      // know one event type's questions, so a name the event does not ask
      // reads as empty and the empty-line rule drops its line.
      formAnswers: declaredAnswers(ctx),
    };
  }

  /**
   * What only the host's copy carries, snapshotted with the rest (ADR 0007):
   * the dashboard link the host acts from and, on the kinds whose host copy
   * shows it (the request, the confirmed booking, the move), who the booking
   * is from and what they answered, so the host can decide from the mail
   * itself. The invitee's payload never holds the other guests' addresses or
   * this labelled answers block (its `{{form.*}}` answers are the invitee's
   * own, and only the event's questions; see `declaredAnswers`).
   *
   * The link is the bookings page behind the host's login, deep-linked to this
   * booking. It never confirms or declines anything by itself: a mail scanner
   * prefetching it lands on a login or a list, and nothing changes.
   */
  private hostSide(ctx: BookingNotificationContext, kind: EmailKind): Partial<BookingNotification> {
    // Only the kinds whose host copy shows the block snapshot it.
    const details = HOST_DETAIL_KINDS.has(kind)
      ? {
          attendee: { ...ctx.attendee },
          guests: ctx.guests,
          answers: collectBookingAnswers(ctx.bookingFields, ctx.formAnswers),
        }
      : {};
    return {
      ...details,
      dashboardUrl: this.env
        ? `${this.env.PUBLIC_APP_URL.replace(/\/+$/, '')}${adminBookingPath(ctx.uid)}`
        : null,
    };
  }

  private toNotification(
    ctx: BookingNotificationContext,
    extra: { manageUrl?: string; cancellationReason?: string | null; previousStartUtc?: string | null },
    // The language this copy is written in, which the Where is worded in too.
    locale: string | null = ctx.hostLocale,
    // The variables this copy's template reads, when it has one.
    reads: ReadonlySet<string> = new Set(),
  ): BookingNotification {
    return {
      accountId: ctx.accountId,
      uid: ctx.uid,
      title: ctx.title,
      eventName: ctx.eventName,
      eventDescription: ctx.eventDescription,
      workspaceName: ctx.workspaceName,
      teamName: ctx.teamName,
      startUtc: ctx.startUtc,
      endUtc: ctx.endUtc,
      host: ctx.host,
      coHosts: ctx.coHosts,
      // Who the mail is about. The phone and notes stay out of the shared
      // snapshot: the host's copy shows them (`hostSide`), and any other copy
      // carries the phone only when its own template asks for `{{attendee_phone}}`.
      attendee: {
        name: ctx.attendee.name,
        email: ctx.attendee.email,
        timeZone: ctx.attendee.timeZone,
        ...(reads.has('attendee_phone') ? { phone: ctx.attendee.phone } : {}),
      },
      // The Where as one human string, rendered from the booking's snapshotted
      // KIND. Deliberately GENERIC for conferencing: the platform name is a
      // host-facing affordance read from the calendar port in the event-type
      // editor (ADR 0008), and reading it from env here instead would both
      // bypass the port and disagree with the public booking page an invitee
      // just used. The link itself is C2's job — resolved at delivery time.
      location: formatBookingLocation(
        ctx.locationKind,
        ctx.location,
        getMessages(locale ?? 'en'),
      ),
      // Snapshotted so DELIVERY can tell whether this booking is even supposed
      // to have a link, and therefore whether waiting for one is warranted.
      // `meetingUrl` is deliberately NOT set here — it does not exist yet.
      locationKind: ctx.locationKind ?? null,
      manageUrl: extra.manageUrl ?? null,
      cancellationReason: extra.cancellationReason ?? null,
      previousStartUtc: extra.previousStartUtc ?? null,
      bookingLink:
        ctx.bookAgain && this.env
          ? `${this.env.PUBLIC_APP_URL}/${ctx.bookAgain.accountCode}/${ctx.bookAgain.handle}/${ctx.bookAgain.slug}`
          : null,
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
   *
   * The conferencing link is RESOLVED here too (ADR 0007), and so is whether
   * the mail carries the Dapta branding (`showBranding`, from the cached
   * verdict). Everything else stays exactly as it was snapshotted at enqueue;
   * the link cannot be, because the calendar row that mints it drains later,
   * and the branding follows a lapse that can land while a row waits. A host
   * row queued before the payload carried the host's zone also reads that zone
   * here, on every attempt, because its snapshot lacks it.
   * `attempts` is how many times this row has already failed; it is
   * what bounds the wait described on `ConferencingLinkPendingError`.
   */
  async deliver(
    kind: string,
    payloadJson: string,
    outboxAccountId?: string | null,
    attempts = 0,
  ): Promise<void> {
    const n = JSON.parse(payloadJson) as BookingNotification & {
      reminderLeadMinutes?: number;
      /** The event-type reminder that scheduled this row; absent on rows queued
       *  before reminders moved off the account. */
      reminderId?: string;
    };
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
    if (LIVE_BOOKING_KINDS.has(kind) && n.uid) {
      const live = await this.db.get<{ status: string; start_ms: number | string }>(
        sql`SELECT status, start_ms FROM booking WHERE uid = ${n.uid} LIMIT 1`,
      );
      if (live && (live.status === 'cancelled' || live.status === 'rejected')) {
        throw new OutboxSkipError(`${kind} for ${n.uid} skipped: the booking is ${live.status}`);
      }
      // A reminder is "before the meeting" or nothing: one held back by a
      // long outage is dropped once the meeting has started.
      if (live && kind === 'reminder' && Number(live.start_ms) <= Date.now()) {
        throw new OutboxSkipError(`reminder for ${n.uid} skipped: the meeting has already started`);
      }
    }
    if ((kind === 'reminder' || kind === 'follow_up') && n.reminderId && n.uid) {
      // A reminder row can sit dormant for 28 days, so the switch is re-read at
      // delivery — the same reason the account toggle was re-read before this
      // change. It now keys on the REMINDER, not the account: a row switched
      // off, or deleted outright, silences the mail it scheduled. Skipping is a
      // decision, not a failure: the row is marked done and never retried.
      const current = await loadBookingNotificationContext(this.db, n.uid);
      // Explicit tenant check rather than an incidental one: `booking.uid` is
      // unique, so this can only ever be the same account — say so.
      if (current && n.accountId && current.accountId !== n.accountId) {
        // Not a routine gate — a booking's account cannot change, so this is an
        // anomaly and deserves the loud record (`skipped` with a reason) rather
        // than a quiet `done` that looks like a delivered row.
        throw new OutboxSkipError(
          `queued ${kind} for ${n.uid} does not belong to the payload's account — skipped`,
        );
      }
      const row = current?.reminders.find((r) => r.id === n.reminderId);
      if (!row || !row.enabled) {
        this.log.log(
          `skip queued ${kind} ${n.reminderId} for ${n.uid} — ${row ? 'switched off' : 'deleted'} on the event type`,
        );
        return;
      }
      // The legacy host-side mute, re-checked here for the same reason every
      // other reminder gate is: a row can sit for weeks after the host muted.
      if (kind === 'reminder' && n.audience === 'host' && n.accountId) {
        const settings = await getNotificationSettings(this.db, n.accountId);
        if (settings.get('host_reminder')?.enabled === false) {
          this.log.log(`skip queued reminder for ${n.uid} — host copies muted on the account`);
          return;
        }
      }
    }
    if (kind === 'follow_up' && !n.reminderId && n.accountId) {
      // Pre-migration row (no reminderId): keep the account gate it was queued
      // under, so nothing already in the outbox changes meaning mid-flight.
      const settings = await getNotificationSettings(this.db, n.accountId);
      const enabled = settings.get('follow_up')?.enabled ?? defaultEnabledFor('follow_up');
      if (!enabled) {
        this.log.log(`skip queued follow-up for ${n.uid} — disabled by account settings`);
        return;
      }
    }
    if (kind === 'reminder' && !n.reminderId && n.accountId) {
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
    // Compatibility backfill, not a delivery-time variable: a host-side row
    // queued before the payload carried the host's zone (a reminder can sit for
    // weeks) has no snapshot of it, so it reads it here, on every attempt, and
    // the host copy is written in the host's zone rather than the invitee's.
    // Rows queued since carry it (null included) and stay as snapshotted.
    if (n.audience === 'host' && n.uid && n.host && n.host.timeZone === undefined) {
      const current = await loadBookingNotificationContext(this.db, n.uid);
      if (current && current.accountId === n.accountId) {
        n.host = { ...n.host, timeZone: current.host.timeZone };
      }
    }
    // --- ADR 0007: the ONE variable resolved at delivery time ----------------
    // Read fresh for every kind, so a reminder scheduled days ago still shows a
    // link that arrived late. Placed after the toggle gates above so a silenced
    // row costs no query and no wait.
    if (n.uid) {
      n.meetingUrl = await loadBookingMeetingUrl(this.db, n.uid);
      // Wait only while a calendar write-out is genuinely still in flight. The
      // location kind alone is NOT enough: a bare fork (disabled provider) and a
      // host who picked `conferencing` with no destination calendar both enqueue
      // no calendar row at all, so no link can ever arrive and there is nothing
      // to wait for. Gating on the kind would delay every one of those bookings
      // for the full budget and log a failure per attempt, for nothing.
      const stillWriting =
        !n.meetingUrl &&
        n.locationKind === 'conferencing' &&
        LINK_AWARE_KINDS.has(kind) &&
        (await hasPendingCalendarJob(this.db, n.uid));
      if (stillWriting && attempts < CONFERENCING_LINK_WAIT_ATTEMPTS) {
        // Bounded: the worker backs this off on the normal schedule, and on the
        // attempt where the budget runs out we fall through and SEND ANYWAY.
        // A calendar failure costs the link, never the email and never the
        // booking — and the manage page self-heals the moment write-out lands.
        throw new ConferencingLinkPendingError(
          `waiting for the conferencing link for ${n.uid} (attempt ${attempts + 1}/${CONFERENCING_LINK_WAIT_ATTEMPTS}) — will send without it after that`,
        );
      }
      if (stillWriting) {
        this.log.warn(
          `sending ${kind} for ${n.uid} WITHOUT a conferencing link — write-out has not produced one after ${attempts} attempts`,
        );
      }
    }
    // The branding is the second value read at delivery: a row can sit for
    // weeks, and a lapsed subscription must bring the "Made with" line back
    // the same way it brings the badge back. Cache only, never a wait on the
    // upstream (`EntitlementGate.showBranding`).
    n.showBranding = await this.gate.showBranding(n.accountId);
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
      case 'follow_up':
        await this.notifier.sendFollowUp(n);
        return;
      default:
        throw new Error(`unknown email kind: ${kind}`);
    }
  }
}
