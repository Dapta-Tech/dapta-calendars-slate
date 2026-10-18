import type { BookingMessages } from '@slate/shared';

/**
 * What the bookings list and a booking's own page both say about a booking,
 * defined once so the two say it the same way: which part of the list it is
 * in (and so which action it offers), its status word and pill, and its start.
 */
export type BookingsMessages = BookingMessages['admin']['bookings'];
export type BookingRowData = { uid: string; status: string; title: string; startUtc: string };

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

/** The booking's start in the host's zone, with the zone's short name. */
export function formatBookingStart(startUtc: string, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
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
