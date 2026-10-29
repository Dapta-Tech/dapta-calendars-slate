import { BOOKING_UTM_KEYS, normalizeBookingUtm, type BookingUtm } from '@slate/types';
import type { RawSearchParams } from '@/lib/embed';

/**
 * The campaign a booking keeps (`booking.utm`): the five `utm_*` parameters of
 * the booking page's own address or, embedded, of the page that frames it.
 *
 * All or nothing, dForms' rule: when the booking page's address carries any
 * `utm_*`, those are the campaign; otherwise the framing page's. Never a mix,
 * which would credit one visit to two campaigns.
 */

/** The page's own campaign, from its query: the first value of each key. */
export function utmFromQuery(query: RawSearchParams | undefined): BookingUtm | null {
  if (!query) return null;
  const raw: Record<string, string> = {};
  for (const key of BOOKING_UTM_KEYS) {
    const value = query[key];
    const first = Array.isArray(value) ? value[0] : value;
    if (typeof first === 'string') raw[key] = first;
  }
  return normalizeBookingUtm(raw);
}

export const CONTEXT_REQUEST_MESSAGE = 'dapta-calendars:context-request';
export const CONTEXT_MESSAGE = 'dapta-calendars:context';

/** How long the page waits for the framing page's answer before booking without it. */
export const CONTEXT_WAIT_MS = 3000;

/** When the request goes out again, in ms from the first: `embed.js` loads
 *  `async`, so on a slow host page it can start listening after this frame. */
export const CONTEXT_RETRY_MS = [400, 1200, 2400] as const;

/**
 * Ask the framing page (its `embed.js`) for the campaign it was opened with.
 * Calls `onUtm` once, with the cleaned UTMs, if an answer comes from the
 * parent window within {@link CONTEXT_WAIT_MS}; asked again at
 * {@link CONTEXT_RETRY_MS} until then. A page framed without `embed.js`, or
 * one that answers nothing, leaves the booking without them. Returns the
 * cleanup.
 */
export function requestHostUtm(onUtm: (utm: BookingUtm) => void, w: Window = window): () => void {
  let done = false;
  const onMessage = (event: MessageEvent) => {
    if (done || event.source !== w.parent) return;
    const data = event.data as { type?: unknown; utm?: unknown } | null;
    if (!data || typeof data !== 'object' || data.type !== CONTEXT_MESSAGE) return;
    done = true;
    stop();
    const utm = normalizeBookingUtm(data.utm);
    if (utm) onUtm(utm);
  };
  const ask = () => {
    try {
      // `*`: the framing site is not knowable from inside the frame, and the
      // request carries nothing.
      w.parent.postMessage({ type: CONTEXT_REQUEST_MESSAGE }, '*');
    } catch {
      stop();
    }
  };
  const timers = [w.setTimeout(() => stop(), CONTEXT_WAIT_MS), ...CONTEXT_RETRY_MS.map((ms) => w.setTimeout(ask, ms))];
  function stop() {
    done = true;
    w.removeEventListener('message', onMessage);
    for (const t of timers) w.clearTimeout(t);
  }
  w.addEventListener('message', onMessage);
  ask();
  return stop;
}
