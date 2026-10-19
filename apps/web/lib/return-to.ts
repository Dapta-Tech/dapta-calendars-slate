/**
 * Where a sign-in sends the person back to.
 *
 * A host who opens a dashboard link while signed out (the "Confirm or decline"
 * button in a request email is the case that matters) is sent through the
 * login first. Without a return target they land on /admin and the booking
 * they came for is lost. So the dashboard's sign-out redirects carry the page
 * the person was on as `?next=`, the login keeps it through the round trip
 * (the hidden field of the local form, a short-lived cookie across the
 * identity-service hand-off), and the end of the login goes there instead of
 * /admin.
 *
 * Every hop reads the value through `safeReturnTo`, because it arrives from a
 * URL or a cookie and ends up in a `Location` header: a return target is an
 * open-redirect surface on the auth path unless it can only name a page of this
 * app. It can only ever name a dashboard page (`/admin` and below) or the
 * OAuth consent page (`/auth/consent`), as a path on this origin.
 *
 * PURE on purpose (no `next/headers`): the route handlers, the login page, the
 * login action and the specs all read it the same way.
 */

/** The query parameter a return target travels in. */
export const RETURN_TO_PARAM = 'next';

/**
 * The one page outside the dashboard a sign-in may return to: the OAuth
 * consent screen, which an app sends a signed-out person to. Exactly this
 * path (with its query), nothing under it.
 */
export const CONSENT_PATH = '/auth/consent';

/**
 * Holds the return target across the identity-service hand-off. The service
 * returns to one fixed callback URL, so the target cannot ride on that URL
 * without changing the contract with it; it waits here, httpOnly and for no
 * longer than the login's own state cookie.
 */
export const RETURN_TO_COOKIE = 'slate_return_to';

/** Long enough for any dashboard URL; a longer value is not one of ours. */
const MAX_LENGTH = 2048;

/** How many percent-decoding layers are looked through before giving up. */
const MAX_DECODE_ROUNDS = 4;

/** A base that is never served, so "is this still on the base" is a real check. */
const BASE = 'http://return-to.invalid';

/** The query parameter Next adds to its own flight requests; never a destination. */
const FLIGHT_PARAM = '_rsc';

/**
 * Whether one layer of a candidate could be read as anything but a plain path
 * on this origin by SOME reader: a browser, a URL parser, a proxy.
 *  - it has to start with exactly one `/` (`//host` is protocol-relative);
 *  - no backslash anywhere (browsers read `/\host` as `//host`);
 *  - no control characters (the URL parser drops tabs and newlines, which
 *    turns `/\t/host` into `//host`).
 */
function unsafeLayer(v: string): boolean {
  if (v[0] !== '/' || v[1] === '/') return true;
  // eslint-disable-next-line no-control-regex
  return /[\\\u0000-\u001f\u007f]/.test(v);
}

/**
 * A dashboard path on this origin, normalized, or null. Rejects anything that
 * is not one (`//evil.example`, `https://evil.example`, `/\evil.example`,
 * `/%2F%2Fevil.example`, `/admin/../api/auth/logout`, …) rather than repairing
 * it: a target that needed repair was not written by this app.
 *
 * Encoded variants are looked through: every percent-decoding of the value
 * must pass the same test, so a layer that some later reader decodes cannot
 * turn into a host. The value returned is the path and query as the URL parser
 * normalizes them (dot segments resolved), without a fragment.
 */
export function safeReturnTo(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_LENGTH) return null;

  let layer = raw;
  for (let round = 0; ; round++) {
    if (unsafeLayer(layer)) return null;
    let decoded: string;
    try {
      decoded = decodeURIComponent(layer);
    } catch {
      return null; // malformed percent-encoding: not a URL this app wrote
    }
    if (decoded === layer) break;
    if (round === MAX_DECODE_ROUNDS) return null;
    layer = decoded;
  }

  let url: URL;
  let decodedUrl: URL;
  try {
    url = new URL(raw, BASE);
    decodedUrl = new URL(layer, BASE);
  } catch {
    return null;
  }
  // Read AFTER the parse, so `/admin/../api` and `/admin/%2e%2e/api` are judged
  // by where they actually go. And judged on the fully decoded layer as well:
  // the parser keeps `%2F` inside one segment, so `/admin/..%2fapi` stays under
  // /admin as written, but a proxy that decodes it before normalizing would
  // land on /api.
  for (const u of [url, decodedUrl]) {
    if (u.origin !== BASE) return null;
    if (u.pathname !== '/admin' && !u.pathname.startsWith('/admin/') && u.pathname !== CONSENT_PATH) return null;
  }
  if (url.searchParams.has(FLIGHT_PARAM)) url.searchParams.delete(FLIGHT_PARAM);
  return `${url.pathname}${url.search}`;
}

/**
 * `path` with the return target appended as `?next=` (or `&next=`), or `path`
 * unchanged when there is no safe one, so a caller can pass whatever it holds.
 */
export function withReturnTo(path: string, returnTo: unknown): string {
  const safe = safeReturnTo(returnTo);
  if (!safe) return path;
  return `${path}${path.includes('?') ? '&' : '?'}${RETURN_TO_PARAM}=${encodeURIComponent(safe)}`;
}

/** The first value of a search param as Next hands it over (a repeat is an array). */
export function firstParam(v: string | string[] | undefined | null): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
