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
