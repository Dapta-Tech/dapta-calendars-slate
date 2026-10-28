/**
 * The ONE place a booking becomes a conversion on the host's own tags (the
 * twin of dForms' `lead-conversion.ts`).
 *
 * The booking page fires a PageView when it loads (`lib/event-tracking.ts`);
 * the confirmation is not a page load, so no tag notices a booking by itself.
 * This tells them:
 *
 *   - Meta Pixel: `Schedule`, Meta's standard event for a booked appointment
 *     (not dForms' `Lead`, so a visitor who fills a form and then books is one
 *     lead and one appointment, not two leads);
 *   - Google Tag Manager: `dataLayer.push({ event: 'booking_scheduled' })`, the
 *     same name the embed's host-page message already uses.
 *
 * Rules it keeps (dForms' three):
 *
 *  1. AFTER the API confirmed: the caller runs it on a booking the write
 *     returned, accepted or pending. A refused or failed submit is not a booking.
 *  2. ONCE per booking: keyed on the booking's uid in `sessionStorage`, so a
 *     re-render, a double click or a replayed answer never counts it twice (an
 *     in-document set stands in when storage is blocked).
 *  3. BEFORE the page leaves: the booking flow calls it ahead of a redirect after
 *     booking, and gives the requests a moment when it returns true.
 *
 * Nothing is created: with no pixel there is no `fbq`, with no container there
 * is no `dataLayer`, and this touches neither. Both calls are wrapped, because a
 * vendor stub that throws must never strand the invitee on the confirmation.
 * Nothing about the invitee is sent: no name, email or booking id.
 */

export const SCHEDULE_PIXEL_EVENT = 'Schedule';
export const SCHEDULE_DATALAYER_EVENT = 'booking_scheduled';

type ConversionWindow = Window & { fbq?: (...args: unknown[]) => void; dataLayer?: unknown[] };

const reportedInThisDocument = new Set<string>();

/** The `sessionStorage` key that marks one booking as reported. */
export function conversionKey(uid: string): string {
  return `dcal-booking-conversion#${uid}`;
}

function claim(w: ConversionWindow, uid: string): boolean {
  if (reportedInThisDocument.has(uid)) return false;
  reportedInThisDocument.add(uid);
  try {
    if (w.sessionStorage.getItem(conversionKey(uid))) return false;
    w.sessionStorage.setItem(conversionKey(uid), '1');
  } catch {
    /* storage blocked: the in-document mark is the whole lock */
  }
  return true;
}

/**
 * Report one booking to the host's tags, at most once. Returns true when a tag
 * was there to tell, which is the booking flow's cue to wait a moment before a
 * redirect after booking so the requests can leave.
 */
export function reportBookingConversion(uid: string, w: ConversionWindow = window): boolean {
  if (!uid) return false;
  const hasPixel = typeof w.fbq === 'function';
  const hasContainer = Array.isArray(w.dataLayer);
  if (!hasPixel && !hasContainer) return false;
  if (!claim(w, uid)) return false;
  try {
    if (hasPixel) w.fbq!('track', SCHEDULE_PIXEL_EVENT);
  } catch {
    /* a broken vendor stub cannot keep the invitee here */
  }
  try {
    if (hasContainer) w.dataLayer!.push({ event: SCHEDULE_DATALAYER_EVENT });
  } catch {
    /* same posture as the pixel */
  }
  return true;
}

/** For tests only: forget the bookings this document reported. */
export function resetConversionsForTests(): void {
  reportedInThisDocument.clear();
}
