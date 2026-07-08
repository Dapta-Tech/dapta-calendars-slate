import type { EmailProvider, EmailResult } from './email.port';

/** Everything a booking notification needs to render, provider-agnostic. */
export interface BookingNotification {
  uid: string;
  title: string;
  startUtc: string;
  endUtc: string;
  host: { name?: string | null };
  attendee: { name: string; email: string; timeZone?: string | null };
  manageUrl?: string | null;
}

/**
 * Renders and sends booking emails through the EmailProvider port. The app only
 * ever calls these methods; the transport is whatever adapter was wired in.
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
      html: `<p>${lines.join('<br/>')}</p>`,
      headers: { 'X-Booking-Uid': n.uid },
    });
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
