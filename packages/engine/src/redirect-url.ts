/**
 * Redirect after booking: which URLs an invitee may be sent to once a booking
 * lands. Pure, so the API (which refuses to store anything else) and the
 * booking page (which refuses to follow anything else, whatever a read
 * returned) apply the one rule.
 */

/** The longest redirect-after-booking URL a host may store (a browser's own practical cap). */
export const MAX_SUCCESS_REDIRECT_URL = 2048;

/** A C0 control character or DEL anywhere in `value` (a code scan, not a regex: lint forbids those). */
function hasControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Whether `value` is a page an invitee may be sent to after booking: an
 * absolute `https://` address with a host and no credentials in it, written
 * without spaces or control characters, within {@link MAX_SUCCESS_REDIRECT_URL}.
 *
 * Only https, like webhook URLs: the browser is what follows it, so there is no
 * server-side fetch to guard, but `javascript:`, `data:` and every other scheme
 * would run or render something in the booking page's own origin, and plain
 * `http://` would hand the invitee to a page anyone on the network can rewrite.
 * The literal prefix check matters: `new URL('https:example.com')` parses, and
 * so does a value with a leading space, and neither is what the host typed.
 */
export function isSuccessRedirectUrl(value: string): boolean {
  if (value.length > MAX_SUCCESS_REDIRECT_URL) return false;
  if (!/^https:\/\//i.test(value) || /\s/.test(value) || hasControlCharacter(value)) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && url.hostname !== '' && url.username === '' && url.password === '';
}

/** What a booking can tell the host's page it redirects to; see {@link bookingRedirectUrl}. */
export interface BookingRedirectDetails {
  eventTypeSlug: string;
  eventTypeName: string;
  startUtc: string;
  endUtc: string;
  /** Accepted, or waiting for the host to confirm. */
  status: string;
  /** The host the booking is with (a team booking's resolved host). */
  hostName?: string | null;
  /** The campaign the booking came from, already cleaned. */
  utm?: Readonly<Record<string, string | undefined>> | null;
  invitee?: { name: string; email: string } | null;
}

/**
 * The redirect after booking with the booking's details on it, Calendly's
 * "pass event details to your redirected page":
 *
 *   - `event`: `event_type`, `event_type_name`, `event_start_time`,
 *     `event_end_time` (ISO UTC), `booking_status`, `assigned_to` and the
 *     booking's `utm_*`;
 *   - `event_and_invitee`: also `invitee_full_name` and `invitee_email`, which
 *     land in the thank-you page's URL and in whatever analytics runs there,
 *     so the host turns them on knowingly;
 *   - null: the address exactly as the host typed it.
 *
 * Never the answers or the booking's uid (the uid opens the invitee's manage
 * page). A parameter the host's address already has wins, and an address that
 * already carries any `utm_*` keeps its own campaign whole (none of the
 * booking's is added: all or nothing, never a mix). The host's own query is
 * kept byte for byte; the details are appended after it. Should the result outgrow
 * {@link MAX_SUCCESS_REDIRECT_URL}, the address goes as typed rather than not
 * at all.
 */
export function bookingRedirectUrl(
  url: string,
  mode: 'event' | 'event_and_invitee' | null | undefined,
  details: BookingRedirectDetails,
): string {
  if (!mode) return url;
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return url;
  }
  const existing = target.searchParams;
  const extra = new URLSearchParams();
  const add = (key: string, value: string | null | undefined) => {
    if (value && !existing.has(key) && !extra.has(key)) extra.set(key, value);
  };
  add('event_type', details.eventTypeSlug);
  add('event_type_name', details.eventTypeName);
  add('event_start_time', details.startUtc);
  add('event_end_time', details.endUtc);
  add('booking_status', details.status);
  add('assigned_to', details.hostName);
  const ownCampaign = [...existing.keys()].some((key) => key.startsWith('utm_'));
  if (!ownCampaign) {
    for (const [key, value] of Object.entries(details.utm ?? {})) {
      if (key.startsWith('utm_')) add(key, value);
    }
  }
  if (mode === 'event_and_invitee' && details.invitee) {
    add('invitee_full_name', details.invitee.name);
    add('invitee_email', details.invitee.email);
  }
  const added = extra.toString();
  if (!added) return url;
  target.search = target.search ? `${target.search}&${added}` : `?${added}`;
  const out = target.toString();
  return isSuccessRedirectUrl(out) ? out : url;
}
