/**
 * The two postMessage channels an embedded booking page speaks (E, from #67).
 *
 * They are deliberately different shapes:
 *
 *   internal    { type:  'dapta-calendars:resize',            height }
 *   host-facing { event: 'dapta-calendars.booking_scheduled', payload }
 *
 * One keys on `type` with a colon and is read only by `public/embed.js`; the
 * other keys on `event` with a dot, mirroring `calendly.event_scheduled` so the
 * origin-checked listener a host already knows works unchanged. Keeping them
 * apart is the point: a page listening for bookings must never have to filter
 * resize chatter out of its own handler, and every frame posts a resize
 * whenever it grows by a pixel.
 *
 * Both go out with `targetOrigin: '*'` — the framing site is not knowable from
 * inside the frame — which is exactly why the host-facing payload carries NO
 * PII. See `postBookingScheduled`.
 */

export const RESIZE_MESSAGE_TYPE = 'dapta-calendars:resize';
export const BOOKING_SCHEDULED_EVENT = 'dapta-calendars.booking_scheduled';

/** A frame taller than this is a runaway measurement, not a booking page. */
export const MAX_EMBED_HEIGHT = 20000;

/** True only when this document is actually inside someone else's frame. */
export function isFramed(): boolean {
  try {
    return typeof window !== 'undefined' && window.parent !== window;
  } catch {
    // A cross-origin parent can throw on access in older engines. If we cannot
    // tell, assume framed: posting into nothing is harmless, not posting when
    // we should have leaves the frame stuck at its `min-height`.
    return true;
  }
}

/** Post the document's current height to the host page. No-op outside a frame. */
export function postResize(height: number): void {
  if (!isFramed()) return;
  const value = Math.min(Math.max(Math.ceil(height), 0), MAX_EMBED_HEIGHT);
  if (!Number.isFinite(value) || value <= 0) return;
  window.parent.postMessage({ type: RESIZE_MESSAGE_TYPE, height: value }, '*');
}

/**
 * The ONE host-facing event this unit ships.
 *
 * `targetOrigin` is `'*'`, so any page that frames a booking page receives
 * this. The payload is therefore restricted to what is already public in the
 * URL (`eventTypeSlug`), the instant that was booked, and a booking reference —
 * no invitee name, no email, nothing the framing site did not already have a
 * right to. The rest of the event ladder waits for a consumer (#67).
 */
export function postBookingScheduled(payload: {
  uid: string;
  startUtc: string;
  eventTypeSlug: string;
}): void {
  if (!isFramed()) return;
  window.parent.postMessage(
    {
      event: BOOKING_SCHEDULED_EVENT,
      payload: {
        uid: payload.uid,
        startUtc: payload.startUtc,
        eventTypeSlug: payload.eventTypeSlug,
      },
    },
    '*',
  );
}
