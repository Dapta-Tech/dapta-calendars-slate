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
 * HubSpot on when the API let them through because the booking host is apart:
 * the API says it with the ids, so the web refuses them on any other origin
 * even when its own setting is missing or late (fail closed). Null when they
 * come through the single-origin allowlist instead, or not at all.
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

function originOf(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    return new URL(value.trim()).origin;
  } catch {
    return null;
  }
}
