import type { ServerEnv } from '@slate/config/env';

/**
 * The base every public booking link names: `PUBLIC_BOOKING_URL` when booking
 * pages have a host of their own, else `PUBLIC_APP_URL` as before. Trailing
 * slashes dropped.
 */
export function publicBookingBase(env: Pick<ServerEnv, 'PUBLIC_APP_URL' | 'PUBLIC_BOOKING_URL'>): string {
  // The booking host's ORIGIN (as the web reads it): a path or query on the
  // setting would name pages the web never serves.
  return originOf(env.PUBLIC_BOOKING_URL) ?? env.PUBLIC_APP_URL.replace(/\/+$/, '');
}

/**
 * The origin a booking page may run Google Tag Manager, Google Analytics and
 * HubSpot on when the API let them through because the booking host is apart.
 * The API says it with the ids, and the web keeps them only when its own
 * `PUBLIC_BOOKING_URL` names the same origin, and starts them only there
 * (fail closed: one side alone, or the two apart, and the web drops them).
 * Null when they come through the single-origin allowlist instead, or not at all.
 */
export function hostScriptsOriginFor(env: Pick<ServerEnv, 'PUBLIC_APP_URL' | 'PUBLIC_BOOKING_URL'> | undefined): string | null {
  return env && bookingHostIsSeparate(env) ? originOf(env.PUBLIC_BOOKING_URL) : null;
}

/**
 * Whether booking pages live on an origin other than the dashboard's: then a
 * host's own tags never run next to a signed-in session, and every workspace
 * may load Google Tag Manager, Google Analytics and HubSpot (the web starts
 * them only on that origin).
 */
export function bookingHostIsSeparate(env: Pick<ServerEnv, 'PUBLIC_APP_URL' | 'PUBLIC_BOOKING_URL'> | undefined): boolean {
  const booking = originOf(env?.PUBLIC_BOOKING_URL);
  return !!booking && booking !== originOf(env?.PUBLIC_APP_URL);
}

/** As the web reads it: an http(s) URL's origin, else null. */
function originOf(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}
