import { withoutHostScriptTracking, type EventTracking } from '@slate/types';
import { bookingOrigin } from '@/lib/booking-host';

type Env = Record<string, string | undefined>;

/** What a booking page hands `EventTracking`. */
export type BookingPageTracking = { tracking: EventTracking | null; hostScriptsOrigin: string | null };

let warned = false;

/**
 * The host's tags a booking page may start, and where: Google Tag Manager,
 * Google Analytics and HubSpot only on the booking host, and only when the API
 * (which opens them to every workspace once booking pages have a host of their
 * own, and names that host with the ids as `trackingHostScriptsOrigin`) and
 * this web (whose own `PUBLIC_BOOKING_URL` is what stops it reading the
 * session's pre-`__Host-` name) name the same one.
 *
 * - Neither names one (one origin, a fork): the ids as the API's allowlist let
 *   them through, anywhere, as before.
 * - Only this web: the allowlist still decides, on the booking host only.
 * - Both, the same: on the booking host only.
 * - Only the API, or the two naming different hosts: the three are dropped
 *   here, on the server, so their ids never reach the page. Meta and PostHog,
 *   which load only their vendor's code, stay.
 */
export function bookingPageTracking(
  source: { tracking?: EventTracking | null; trackingHostScriptsOrigin?: string | null },
  env: Env = process.env,
): BookingPageTracking {
  const tracking = source.tracking ?? null;
  const api = source.trackingHostScriptsOrigin ?? null;
  const web = bookingOrigin(env);
  if (!api || api === web) return { tracking, hostScriptsOrigin: web };
  if (!warned) {
    warned = true;
    console.warn(
      `[web] the API names ${api} as the booking host and this web's PUBLIC_BOOKING_URL names ${web ?? 'none'}: ` +
        'Google Tag Manager, Google Analytics and HubSpot stay off on booking pages until the two agree.',
    );
  }
  return { tracking: withoutHostScriptTracking(tracking), hostScriptsOrigin: null };
}

export function resetBookingPageTrackingWarningForTests(): void {
  warned = false;
}
