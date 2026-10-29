/**
 * The ONE place the booking funnel reaches the host's own tags (the twin of
 * dForms' `lead-conversion.ts`, with the steps before the booking too).
 *
 * The booking page fires a page view when it loads (`lib/event-tracking.ts`);
 * the steps after it are not page loads, so no tag notices them by itself. This
 * tells every tag the page started:
 *
 *   | step          | GTM (dataLayer)         | GA4 (gtag)              | Meta Pixel            | PostHog (host's own)    |
 *   |---------------|-------------------------|-------------------------|-----------------------|-------------------------|
 *   | a day picked  | `booking_date_selected` | `booking_date_selected` | `BookingDateSelected` | `booking_date_selected` |
 *   | a time picked | `booking_time_selected` | `booking_time_selected` | `BookingTimeSelected` | `booking_time_selected` |
 *   | booked        | `booking_scheduled`     | `booking_scheduled`     | `Schedule` (standard) | `booking_scheduled`     |
 *
 * Meta's `Schedule` is its standard event for a booked appointment (not dForms'
 * `Lead`, so a visitor who fills a form and then books is one lead and one
 * appointment, not two leads); the two steps before it are custom events.
 *
 * Each event carries the same details, and nothing about the invitee: the event
 * type's slug, its length, personal or team and, once a time is picked, its
 * start; once booked, whether it was accepted or waits for the host. Never a
 * name, an email, the answers or the booking's uid (the uid opens the invitee's
 * manage page). The dataLayer gets them under `dcal`, so they never collide
 * with a container's own variables.
 *
 * Rules it keeps (dForms' three, for the booking):
 *
 *  1. AFTER the API confirmed: the caller runs it on a booking the write
 *     returned, accepted or pending. A refused or failed submit is not a booking.
 *  2. ONCE per booking: keyed on the booking's uid in `sessionStorage`, so a
 *     re-render, a double click or a replayed answer never counts it twice (an
 *     in-document set stands in when storage is blocked).
 *  3. BEFORE the page leaves: the booking flow calls it ahead of a redirect after
 *     booking, and gives the requests a moment when it returns true.
 *
 * Nothing is created: with no pixel there is no `fbq`, with no container no
 * `dataLayer`, with no measurement id no GA4 `gtag`, and this touches none of
 * them. Every call is wrapped, because a vendor stub that throws must never
 * strand the invitee on the confirmation.
 */

import { EVENT_OWNER_POSTHOG, GA4_GTAG } from '@/lib/event-tracking';

export const SCHEDULE_PIXEL_EVENT = 'Schedule';
export const SCHEDULE_DATALAYER_EVENT = 'booking_scheduled';
export const DATE_SELECTED_EVENT = 'booking_date_selected';
export const TIME_SELECTED_EVENT = 'booking_time_selected';
export const DATE_SELECTED_PIXEL_EVENT = 'BookingDateSelected';
export const TIME_SELECTED_PIXEL_EVENT = 'BookingTimeSelected';

/** What every event says about the booking page, and nothing about the invitee. */
export interface BookingEventDetails {
  eventTypeSlug: string;
  durationMinutes: number;
  isTeam: boolean;
  /** The picked or booked start, ISO UTC (the time step and the booking). */
  startUtc?: string | null;
  /** The picked day, `YYYY-MM-DD` in the page's zone (the day step). */
  date?: string | null;
  /** Accepted, or waiting for the host to confirm (the booking). */
  status?: string | null;
}

type Capture = (event: string, props?: object) => void;

type ConversionWindow = Window & {
  fbq?: (...args: unknown[]) => void;
  dataLayer?: unknown[];
  [GA4_GTAG]?: (...args: unknown[]) => void;
  posthog?: Record<string, unknown>;
};

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

/** The details as event properties, the empty ones left out. */
function propertiesOf(details: BookingEventDetails | undefined): Record<string, string | number | boolean> {
  if (!details) return {};
  const out: Record<string, string | number | boolean> = {
    event_type: details.eventTypeSlug,
    duration_minutes: details.durationMinutes,
    is_team: details.isTeam,
  };
  if (details.date) out.date = details.date;
  if (details.startUtc) out.start_time = details.startUtc;
  if (details.status) out.booking_status = details.status;
  return out;
}

/**
 * The tags this page runs, by what each vendor's loader left on the window. A
 * GTM container is the `gtm.js` start its loader pushed, not a bare `dataLayer`
 * (another script may have made one). GA4 is dCal's own `gtag` on GA4's own
 * layer (`GA4_GTAG`), never GTM's, so a container never hears an event twice.
 */
function tagsOn(w: ConversionWindow) {
  const owner = w.posthog?.[EVENT_OWNER_POSTHOG] as { capture?: unknown } | undefined;
  return {
    pixel: typeof w.fbq === 'function',
    container:
      Array.isArray(w.dataLayer) &&
      w.dataLayer.some((entry) => typeof entry === 'object' && entry !== null && (entry as { event?: unknown }).event === 'gtm.js'),
    gtag: typeof w[GA4_GTAG] === 'function',
    posthog: owner && typeof owner.capture === 'function' ? (owner.capture as Capture).bind(owner) : null,
  };
}

const anyTag = (tags: ReturnType<typeof tagsOn>) => tags.pixel || tags.container || tags.gtag || Boolean(tags.posthog);

function safely(run: () => void): void {
  try {
    run();
  } catch {
    /* a broken vendor stub cannot keep the invitee here */
  }
}

/** Tell every tag one event. Returns true when a tag was there to tell. */
function send(
  w: ConversionWindow,
  names: { standard: string; pixel: string; pixelStandard: boolean },
  details: BookingEventDetails | undefined,
): boolean {
  const tags = tagsOn(w);
  if (!anyTag(tags)) return false;
  const props = propertiesOf(details);
  if (tags.pixel) {
    // Meta's own `content_name` names the event type; the details ride beside it.
    const params = details ? { ...props, content_name: details.eventTypeSlug } : null;
    safely(() => {
      if (!names.pixelStandard) w.fbq!('trackCustom', names.pixel, params ?? {});
      else if (params) w.fbq!('track', names.pixel, params);
      else w.fbq!('track', names.pixel);
    });
  }
  if (tags.container) safely(() => w.dataLayer!.push({ event: names.standard, ...(details ? { dcal: props } : {}) }));
  if (tags.gtag) safely(() => w[GA4_GTAG]!('event', names.standard, props));
  if (tags.posthog) safely(() => tags.posthog!(names.standard, props));
  return true;
}

/**
 * Report one booking to the host's tags, at most once. Returns true when a tag
 * was there to tell, which is the booking flow's cue to wait a moment before a
 * redirect after booking so the requests can leave.
 */
export function reportBookingConversion(
  uid: string,
  w: ConversionWindow = window,
  details?: BookingEventDetails,
): boolean {
  if (!uid) return false;
  if (!anyTag(tagsOn(w))) return false;
  if (!claim(w, uid)) return false;
  return send(w, { standard: SCHEDULE_DATALAYER_EVENT, pixel: SCHEDULE_PIXEL_EVENT, pixelStandard: true }, details);
}

/**
 * Report a step before the booking (a day picked, a time picked). Every pick
 * counts, so a visitor who looks at three days says so three times; the flow
 * sends a day once until another one is picked.
 */
export function reportBookingStep(
  step: 'date_selected' | 'time_selected',
  details: BookingEventDetails,
  w: ConversionWindow = window,
): boolean {
  const names =
    step === 'date_selected'
      ? { standard: DATE_SELECTED_EVENT, pixel: DATE_SELECTED_PIXEL_EVENT, pixelStandard: false }
      : { standard: TIME_SELECTED_EVENT, pixel: TIME_SELECTED_PIXEL_EVENT, pixelStandard: false };
  return send(w, names, details);
}

/** For tests only: forget the bookings this document reported. */
export function resetConversionsForTests(): void {
  reportedInThisDocument.clear();
}
