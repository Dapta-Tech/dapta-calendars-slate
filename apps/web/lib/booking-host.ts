import { httpOrigin } from '@slate/config/url';
import { EMBED_PARAM, isEmbedValue } from '@/lib/embed-mode';
import { isProductPath } from '@/lib/theme';

/**
 * Booking pages on a host of their own (`PUBLIC_BOOKING_URL`, cloud:
 * `book.<domain>`), apart from the dashboard (`PUBLIC_APP_URL`), so the hosts'
 * own tags that run on a booking page never share an origin with a signed-in
 * session.
 *
 * Unset, or equal to the app's origin (every bare fork): one origin, as before,
 * and nothing here changes anything.
 *
 * The move happens in steps, each one undone by reverting its setting:
 *   1. `PUBLIC_BOOKING_URL` set: the booking host serves every public page and
 *      bounces the dashboard's paths to the app host; links the app writes
 *      (emails, the dashboard, MCP) name it. The app host still serves public
 *      pages too, so nothing that was shared before breaks.
 *   2. `BOOKING_HOST_REDIRECTS=temporary`: every other host answers a public
 *      page's GET with a 307 to the same path and query on the booking host.
 *   3. `permanent` (308), once the move has been stable for a month.
 * A POST is always served where it lands: an open tab's Server Action, which a
 * cross-origin redirect would break.
 */

export type BookingRedirectMode = 'off' | 'temporary' | 'permanent';

type Env = Record<string, string | undefined>;


/** The app's own origin (`PUBLIC_APP_URL`), or null when unset or not a URL. */
export function appOrigin(env: Env = process.env): string | null {
  return httpOrigin(env.PUBLIC_APP_URL);
}

/**
 * The origin booking pages live on, or null when this deployment serves them on
 * the app's origin (unset, not a URL, or the same origin as the app).
 */
export function bookingOrigin(env: Env = process.env): string | null {
  const booking = httpOrigin(env.PUBLIC_BOOKING_URL);
  if (!booking) return null;
  return booking === appOrigin(env) ? null : booking;
}

/** Whether other hosts redirect public pages to the booking host, and how. */
export function bookingRedirectMode(env: Env = process.env): BookingRedirectMode {
  const value = env.BOOKING_HOST_REDIRECTS?.trim().toLowerCase();
  return value === 'temporary' || value === 'permanent' ? value : 'off';
}

/**
 * Paths every host serves as they are, never redirected or bounced: build
 * assets, the booking page's own same-origin read (`/api/availability` must
 * answer on whichever host the open page is on), `embed.js` (old snippets load
 * it from the app host), the icons, `robots.txt`, and the API's MCP and OAuth
 * paths routed through the web host. The rest of `/api` (sign-in, sign-out,
 * the workspace and the developer skill) is the dashboard's.
 */
const SHARED_PREFIXES: readonly string[] = [
  '/_next',
  '/dapta-mark.png',
  '/api/availability',
  '/embed.js',
  '/favicon.ico',
  '/icon.svg',
  '/apple-icon.png',
  '/robots.txt',
  '/mcp',
  '/oauth',
  '/.well-known',
];

export function isSharedPath(path: string): boolean {
  return SHARED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/** A public booking page: everything the product does not own and every host does not share. */
export function isBookingPath(path: string): boolean {
  return !isSharedPath(path) && !isProductPath(path);
}

/**
 * Route handlers that change the signed-in state on a GET (start a sign-in,
 * sign out, refresh, reset or switch the workspace, install the developer
 * skill). Starting a sign-in counts: it sets the short-lived OAuth state
 * cookie, and the callback's only binding is that the cookie exists (the
 * identity service does not echo a state), so a sign-in started by another
 * host's script would let that script finish it with a session of its own
 * choosing (login CSRF). A sibling host
 * on the same site can make the browser request them with the session cookie
 * from an image, a script or a fetch; on the app host those same-site
 * subresource requests are refused. A full-page navigation is not: any site
 * can already start one (the session cookie is `SameSite=Lax`), and the
 * dashboard's own redirect chains (a stale session going through the refresh,
 * started by a click on the landing) arrive as same-site navigations.
 */
const STATE_CHANGING_GETS: readonly string[] = [
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/refresh',
  '/api/workspace/reset',
  '/api/developers/skill',
  '/admin/join',
];

export type HostDecision =
  | { kind: 'next'; bookingHost: boolean }
  | { kind: 'redirect'; url: string; status: 307 | 308 }
  | { kind: 'refuse'; status: 403 | 404 };

/**
 * What one request gets, from its host, method, path, query and Fetch Metadata.
 * Pure, so the redirect matrix is tested without a server.
 */
export function routeForHost(
  req: {
    host: string;
    method: string;
    pathname: string;
    search: string;
    /** `Sec-Fetch-Site`, `Sec-Fetch-Mode` and `Sec-Fetch-Dest`, when the browser sent them. */
    fetchSite?: string | null;
    fetchMode?: string | null;
    fetchDest?: string | null;
    /** `Sec-Purpose` (or the older `Purpose`): a prefetch or prerender says so. */
    purpose?: string | null;
  },
  env: Env = process.env,
): HostDecision {
  const booking = bookingOrigin(env);
  if (!booking) return { kind: 'next', bookingHost: false };
  const safe = req.method === 'GET' || req.method === 'HEAD';
  const onBookingHost = req.host === new URL(booking).host;

  if (onBookingHost) {
    if (isSharedPath(req.pathname) || !isProductPath(req.pathname)) return { kind: 'next', bookingHost: true };
    // The dashboard's paths, and `/`, belong to the app host.
    const app = appOrigin(env);
    if (!safe || !app) return { kind: 'refuse', status: 404 };
    // Temporary: a browser keeps no permanent redirect a later setting would contradict.
    return { kind: 'redirect', url: `${app}${req.pathname}${req.search}`, status: 307 };
  }

  // The app host (or an older alias). A request a page on another host of the
  // same site made the browser send, the booking host's above all, may read
  // but not write: anything but a GET or HEAD is refused, and so is a GET to a
  // handler that changes the signed-in state. Cross-site requests are Next's
  // own Server Action check and the cookies' SameSite; same-site ones carry
  // the session cookie, which is why this is here.
  // A prefetch or prerender (speculation rules on another host's page) is not
  // the person navigating, even when it looks like a document navigation.
  const speculative = /prefetch|prerender/i.test(req.purpose ?? '');
  const navigation = !speculative && req.fetchMode === 'navigate' && (req.fetchDest === 'document' || !req.fetchDest);
  if (req.fetchSite === 'same-site' && (!safe || (isStateChangingGet(req.pathname) && !navigation))) {
    return { kind: 'refuse', status: 403 };
  }

  const mode = bookingRedirectMode(env);
  // A frame is not moved: an embed on a site whose CSP allows only the old
  // host as a frame source would break on the redirect's hop. It keeps
  // booking there; the host-script tags stay off on that origin. Told by
  // `Sec-Fetch-Dest`, or, where a browser or webview sends no Fetch Metadata,
  // by the embed mode every snippet's frame carries (an embed address opened
  // in a tab by such a browser stays too, which only costs the move).
  const framed = req.fetchDest === 'iframe' || req.fetchDest === 'frame' || (!req.fetchDest && inEmbedMode(req.search));
  if (mode !== 'off' && safe && !framed && isBookingPath(req.pathname)) {
    return { kind: 'redirect', url: `${booking}${req.pathname}${req.search}`, status: mode === 'permanent' ? 308 : 307 };
  }
  return { kind: 'next', bookingHost: false };
}

/** The query asks for embed mode, by the one rule the pages use (`lib/embed-mode.ts`). */
function inEmbedMode(search: string): boolean {
  return isEmbedValue(new URLSearchParams(search).get(EMBED_PARAM));
}

function isStateChangingGet(path: string): boolean {
  return STATE_CHANGING_GETS.some((p) => path === p || path.startsWith(`${p}/`));
}
