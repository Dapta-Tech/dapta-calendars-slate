import type { EmailProvider, EmailResult } from './email.port';
import { buildIcs, icsContentType } from './ics';
import { escapeHtml } from './util';

/** Render plaintext lines to a safe HTML body — every line HTML-escaped (E8). */
function htmlBody(lines: string[]): string {
  return `<p>${lines.map(escapeHtml).join('<br/>')}</p>`;
}

/** Everything a booking notification needs to render, provider-agnostic. */
export interface BookingNotification {
  uid: string;
  title: string;
  startUtc: string;
  endUtc: string;
  host: { name?: string | null; email?: string | null };
  /** Additional assigned hosts (collective / fixed_round_robin) — also notified. */
  coHosts?: Array<{ name?: string | null; email?: string | null }>;
  attendee: { name: string; email: string; timeZone?: string | null };
  location?: string | null;
  manageUrl?: string | null;
  cancellationReason?: string | null;
  previousStartUtc?: string | null;
  /** DTSTAMP for the .ics (injected for determinism). Defaults to startUtc. */
  stamp?: string;
}

/**
 * Renders and sends booking emails through the EmailProvider port, each with an
 * .ics invite where appropriate (SEQUENCE 0/1/2 for confirm/reschedule/cancel;
 * stable UID). The app only ever calls these methods; the transport is whatever
 * adapter is wired.
 *
 * Recipients: confirmation/reschedule/cancellation go to the attendee AND the
 * host (deduped) — parity with the old service, which mailed both. The
 * pending-request and declined mails are attendee-only (the host drives those
 * from the dashboard).
 */
export class BookingNotifier {
  constructor(private readonly email: EmailProvider) {}

  /** Attendee + host + any co-hosts, deduped, empty entries dropped. */
  private recipients(n: BookingNotification): string[] {
    const set = new Set<string>();
    if (n.attendee.email) set.add(n.attendee.email);
    if (n.host.email) set.add(n.host.email);
    for (const h of n.coHosts ?? []) if (h.email) set.add(h.email);
    return [...set];
  }

  sendConfirmation(n: BookingNotification): Promise<EmailResult> {
    const when = formatWhen(n.startUtc, n.attendee.timeZone ?? 'UTC');
    const lines = [
      `Hi ${n.attendee.name},`,
      ``,
      `Your booking "${n.title}" is confirmed.`,
      `When: ${when}`,
      n.host.name ? `Host: ${n.host.name}` : '',
      n.location ? `Where: ${n.location}` : '',
      n.manageUrl ? `Manage your booking: ${n.manageUrl}` : '',
    ].filter(Boolean);
    return this.email.send({
      to: this.recipients(n),
      subject: `Confirmed: ${n.title} — ${when}`,
      text: lines.join('\n'),
      html: htmlBody(lines),
      headers: { 'X-Booking-Uid': n.uid },
      idempotencyKey: `calendar:${n.uid}:confirmation`,
      attachments: [this.ics(n, 'REQUEST', 0)],
    });
  }

  /**
   * A scheduled REMINDER before the meeting (attendee + host). No new .ics — the
   * confirmed invite already lives in the calendar; this is just a nudge. The
   * `payload` carries `reminderLeadMinutes` so the copy can say "starts in X".
   */
  sendReminder(n: BookingNotification & { reminderLeadMinutes?: number }): Promise<EmailResult> {
    const when = formatWhen(n.startUtc, n.attendee.timeZone ?? 'UTC');
    const lead = n.reminderLeadMinutes;
    const inWord =
      lead == null ? 'soon' : lead % 1440 === 0 ? `in ${lead / 1440} day(s)` : lead % 60 === 0 ? `in ${lead / 60} hour(s)` : `in ${lead} minutes`;
    const lines = [
      `Hi ${n.attendee.name},`,
      ``,
      `Reminder: "${n.title}" starts ${inWord}.`,
      `When: ${when}`,
      n.host.name ? `Host: ${n.host.name}` : '',
      n.location ? `Where: ${n.location}` : '',
      n.manageUrl ? `Manage your booking: ${n.manageUrl}` : '',
    ].filter(Boolean);
    return this.email.send({
      to: this.recipients(n),
      subject: `Reminder: ${n.title} — ${when}`,
      text: lines.join('\n'),
      html: htmlBody(lines),
      headers: { 'X-Booking-Uid': n.uid },
      // Distinct per lead so two reminders (24h, 1h) aren't de-duped as one.
      idempotencyKey: `calendar:${n.uid}:reminder:${lead ?? 'x'}`,
      // No .ics on a reminder.
    });
  }

  /**
   * B5: a `requiresConfirmation` booking is PENDING, not confirmed. Tell the
   * attendee we received the request — and DO NOT attach a CONFIRMED invite (no
   * .ics), so their calendar isn't populated with an event the host may decline.
   */
  sendPendingRequest(n: BookingNotification): Promise<EmailResult> {
    const when = formatWhen(n.startUtc, n.attendee.timeZone ?? 'UTC');
    const lines = [
      `Hi ${n.attendee.name},`,
      ``,
      `We received your request to book "${n.title}".`,
      `When: ${when}`,
      n.host.name ? `Host: ${n.host.name}` : '',
      `This is pending confirmation${n.host.name ? ` by ${n.host.name}` : ''}. ` +
        `You'll get another email once it's confirmed.`,
      n.manageUrl ? `Cancel this request: ${n.manageUrl}` : '',
    ].filter(Boolean);
    return this.email.send({
      // Host is copied too — a pending request is the host's cue to confirm/decline.
      to: this.recipients(n),
      subject: `Request received: ${n.title} — ${when}`,
      text: lines.join('\n'),
      html: htmlBody(lines),
      headers: { 'X-Booking-Uid': n.uid },
      idempotencyKey: `calendar:${n.uid}:pending`,
      // No .ics on purpose — nothing is confirmed yet.
    });
  }

  /** B3: the host declined a pending request — tell the attendee it's off. */
  sendDeclined(n: BookingNotification): Promise<EmailResult> {
    const when = formatWhen(n.startUtc, n.attendee.timeZone ?? 'UTC');
    const lines = [
      `Hi ${n.attendee.name},`,
      ``,
      `Unfortunately your request to book "${n.title}" (${when}) was not accepted.`,
      n.cancellationReason ? `Reason: ${n.cancellationReason}` : '',
    ].filter(Boolean);
    return this.email.send({
      // Host is copied too — confirms to the host that the request was declined.
      to: this.recipients(n),
      subject: `Not accepted: ${n.title} — ${when}`,
      text: lines.join('\n'),
      html: htmlBody(lines),
      headers: { 'X-Booking-Uid': n.uid },
      idempotencyKey: `calendar:${n.uid}:declined`,
      // No .ics — the pending request never produced a confirmed event.
    });
  }

  sendReschedule(n: BookingNotification): Promise<EmailResult> {
    const when = formatWhen(n.startUtc, n.attendee.timeZone ?? 'UTC');
    const prev = n.previousStartUtc ? formatWhen(n.previousStartUtc, n.attendee.timeZone ?? 'UTC') : null;
    const lines = [
      `Hi ${n.attendee.name},`,
      ``,
      `Your booking "${n.title}" has been rescheduled.`,
      prev ? `Was: ${prev}` : '',
      `Now: ${when}`,
      n.host.name ? `Host: ${n.host.name}` : '',
      n.location ? `Where: ${n.location}` : '',
      n.manageUrl ? `Manage your booking: ${n.manageUrl}` : '',
    ].filter(Boolean);
    return this.email.send({
      to: this.recipients(n),
      subject: `Rescheduled: ${n.title} — ${when}`,
      text: lines.join('\n'),
      html: htmlBody(lines),
      headers: { 'X-Booking-Uid': n.uid },
      // Keyed by the TARGET start: a retry of the same reschedule is de-duped,
      // but a second reschedule to a different time is a distinct message.
      idempotencyKey: `calendar:${n.uid}:reschedule:${n.startUtc}`,
      attachments: [this.ics(n, 'REQUEST', 1)],
    });
  }

  sendCancellation(n: BookingNotification): Promise<EmailResult> {
    const when = formatWhen(n.startUtc, n.attendee.timeZone ?? 'UTC');
    const lines = [
      `Hi ${n.attendee.name},`,
      ``,
      `Your booking "${n.title}" (${when}) has been cancelled.`,
      n.cancellationReason ? `Reason: ${n.cancellationReason}` : '',
    ].filter(Boolean);
    return this.email.send({
      to: this.recipients(n),
      subject: `Cancelled: ${n.title} — ${when}`,
      text: lines.join('\n'),
      html: htmlBody(lines),
      headers: { 'X-Booking-Uid': n.uid },
      idempotencyKey: `calendar:${n.uid}:cancellation`,
      attachments: [this.ics(n, 'CANCEL', 2)],
    });
  }

  private ics(n: BookingNotification, method: 'REQUEST' | 'CANCEL', sequence: number) {
    return {
      filename: 'invite.ics',
      content: buildIcs({
        uid: n.uid,
        method,
        sequence,
        startUtc: n.startUtc,
        endUtc: n.endUtc,
        title: n.title,
        location: n.location,
        organizer: n.host,
        attendees: [{ name: n.attendee.name, email: n.attendee.email }],
        stamp: n.stamp ?? n.startUtc,
      }),
      contentType: icsContentType(method),
    };
  }
}

function formatWhen(iso: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}
