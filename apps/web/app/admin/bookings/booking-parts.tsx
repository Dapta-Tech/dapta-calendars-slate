import { t, type BookingMessages, type Locale } from '@slate/shared';
import type { BookingRepeats } from '@/lib/admin-api';

/**
 * What the bookings list and a booking's own page both say about a booking,
 * defined once so the two say it the same way: which part of the list it is
 * in (and so which action it offers), its status word and pill, and its start.
 */
export type BookingsMessages = BookingMessages['admin']['bookings'];
export type BookingRowData = { uid: string; status: string; title: string; startUtc: string; repeats?: BookingRepeats | null };

/** The list's three parts. `pending` offers Confirm/Decline, `upcoming` Cancel. */
export type BookingSection = 'pending' | 'upcoming' | 'past';

export function bookingSection(b: Pick<BookingRowData, 'status' | 'startUtc'>, now: number): BookingSection {
  if (b.status === 'pending') return 'pending';
  if (b.status === 'accepted' && new Date(b.startUtc).getTime() > now) return 'upcoming';
  return 'past';
}

/** Localized label for a raw booking status string. */
export function statusLabel(status: string, m: BookingsMessages): string {
  switch (status) {
    case 'accepted':
      return m.statusAccepted;
    case 'pending':
      return m.statusPending;
    case 'cancelled':
      return m.statusCancelled;
    case 'rejected':
      return m.statusRejected;
    default:
      return status;
  }
}

/**
 * The Intl locale a dashboard date is written in: Spanish for a Spanish
 * reader ("jue, 19 nov, 18:00 GMT-5"), else the US English it always was.
 */
export function dateLocale(locale: Locale): string {
  return locale === 'es' ? 'es' : 'en-US';
}

/** The booking's start in the host's zone, with the zone's short name, in the reader's language. */
export function formatBookingStart(startUtc: string, timeZone: string, locale: Locale = 'en'): string {
  return new Intl.DateTimeFormat(dateLocale(locale), {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone,
    timeZoneName: 'short',
  }).format(new Date(startUtc));
}

/**
 * A status pill, NOT a button: a solid background paired with a foreground
 * text color is reserved for real actions (Accept/Cancel use exactly that
 * fill). A same-styled "accepted" pill next to a real Cancel button reads as a
 * second, broken button. That was the reported "Accept doesn't work" bug:
 * there was no pending booking to show real Accept/Decline controls, only this
 * pill on an already-accepted booking, styled like one. A soft tint fill (10
 * percent background opacity, colored text) keeps the status legible and
 * color-coded while being visually unmistakable as non-interactive (same
 * convention as the member and role pills elsewhere in admin).
 */
export function BookingStatusPill({ status, m }: { status: string; m: BookingsMessages }) {
  return (
    <span
      className={`rounded-sm px-inline py-tight text-xs font-medium ${
        status === 'accepted'
          ? 'bg-primary/10 text-primary'
          : status === 'pending'
            ? 'bg-secondary/10 text-secondary'
            : status === 'cancelled' || status === 'rejected'
              ? 'bg-destructive/10 text-destructive'
              : 'bg-muted text-muted-foreground'
      }`}
    >
      {statusLabel(status, m)}
    </span>
  );
}

/** A weekday's name in the reader's language ('wednesday' → "Wednesday" / "miércoles"). */
function weekdayName(day: string, locale: Locale): string {
  const order = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
  const i = order.indexOf(day);
  if (i < 0) return day;
  // 2024-01-01 was a Monday.
  return new Intl.DateTimeFormat(dateLocale(locale), { weekday: 'long', timeZone: 'UTC' }).format(new Date(Date.UTC(2024, 0, 1 + i)));
}

/** "Every Wednesday at 15:30, no end date": how a date of a repeating event repeats, in the reader's language. */
export function repeatsText(r: BookingRepeats, m: BookingsMessages, locale: Locale = 'en'): string {
  const days = new Intl.ListFormat(dateLocale(locale), { style: 'long', type: 'conjunction' }).format(
    r.weekdays.map((d) => weekdayName(d, locale)),
  );
  const every =
    r.frequency === 'daily'
      ? r.interval === 1
        ? t(m.repeatsDaily, { time: r.startTime })
        : t(m.repeatsEveryDays, { n: String(r.interval), time: r.startTime })
      : r.interval === 1
        ? t(m.repeatsWeekly, { days, time: r.startTime })
        : t(m.repeatsEveryWeeks, { n: String(r.interval), days, time: r.startTime });
  const end =
    r.count !== null ? t(m.repeatsCount, { count: String(r.count) }) : r.untilDate ? t(m.repeatsUntil, { date: r.untilDate }) : m.repeatsNoEnd;
  return `${every}, ${end} (${r.timeZone.replaceAll('_', ' ')})`;
}

/** The list's mark on a date of a repeating event: a soft tint like the status pill, never a button. */
export function RepeatsPill({ repeats, m, locale = 'en' }: { repeats: BookingRepeats; m: BookingsMessages; locale?: Locale }) {
  return (
    <span className="rounded-sm bg-muted px-inline py-tight text-xs font-medium text-muted-foreground" title={repeatsText(repeats, m, locale)}>
      {m.repeats}
    </span>
  );
}
