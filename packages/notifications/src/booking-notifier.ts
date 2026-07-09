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
 * .ics invite (SEQUENCE 0/1/2 for confirm/reschedule/cancel; stable UID). The
 * app only ever calls these methods; the transport is whatever adapter is wired.
 */
export class BookingNotifier {
  constructor(private readonly email: EmailProvider) {}

  sendConfirmation(n: BookingNotification): Promise<EmailResult> {
    const when = formatWhen(n.startUtc, n.attendee.timeZone ?? 'UTC');
    const lines = [
      `Hi ${n.attendee.name},`,
      ``,
      `Your booking "${n.title}" is confirmed.`,
      `When: ${when}`,
      n.host.name ? `Host: ${n.host.name}` : '',
      n.manageUrl ? `Manage your booking: ${n.manageUrl}` : '',
    ].filter(Boolean);
    return this.email.send({
      to: n.attendee.email,
      subject: `Confirmed: ${n.title} — ${when}`,
      text: lines.join('\n'),
      html: htmlBody(lines),
      headers: { 'X-Booking-Uid': n.uid },
      attachments: [this.ics(n, 'REQUEST', 0)],
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
      n.manageUrl ? `Manage your booking: ${n.manageUrl}` : '',
    ].filter(Boolean);
    return this.email.send({
      to: n.attendee.email,
      subject: `Rescheduled: ${n.title} — ${when}`,
      text: lines.join('\n'),
      html: htmlBody(lines),
      headers: { 'X-Booking-Uid': n.uid },
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
      to: n.attendee.email,
      subject: `Cancelled: ${n.title} — ${when}`,
      text: lines.join('\n'),
      html: htmlBody(lines),
      headers: { 'X-Booking-Uid': n.uid },
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
