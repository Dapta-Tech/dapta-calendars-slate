import { NextResponse, type NextRequest } from 'next/server';
import {
  ATTRIBUTION_COOKIE,
  ATTRIBUTION_WINDOW_MS,
  LANDING_ID_COOKIE,
  LANDING_ID_QUERY_KEY,
  parseAttribution,
  reportableRequestId,
  resolveAnalyticsConfig,
  sanitizeLandingDistinctId,
} from '@slate/shared';
import { PATH_HEADER, QUERY_HEADER } from '@/lib/theme';
import { framingHeaders } from '@/lib/framing';
import { NOINDEX_HEADER_VALUE, deploymentNoindex } from '@/lib/indexing';
import { requestOrigin } from '@/lib/request-origin';
import { routeForHost } from '@/lib/booking-host';

/**
 * Canonical-host redirect: the Dapta cloud deployment's canonical hosts are
 * SINGULAR (calendar.dapta.ai / calendar.dapta.dev); the plural variants stay
 * routable as aliases so links shared before the rename keep working, but they
 * 308 here to the canonical host. Inert for forks — it only matches the
 * dapta.ai/.dev plural hosts, which nobody else serves.
 */
const CANONICAL: Record<string, string> = {
  'calendars.dapta.ai': 'calendar.dapta.ai',
  'calendars.dapta.dev': 'calendar.dapta.dev',
};

/**
 * O2 — where a campaign click is remembered (#94, refining #65).
 *
 * #65 said "the root page forwards the params into the login hand-off". That is
 * not implementable where it is written: the root page is a React Server
 * Component, and Next does not permit setting a cookie during render — only a
 * Route Handler, a Server Action, or middleware may. Middleware is the right
 * place regardless: it already runs on every page request, it sees the request
 * HEADERS (so the referrer is server-read and never caller-supplied), and what
 * it parks survives the whole identity round-trip whichever login path this
 * deployment uses. Forwarding through the login URL instead would re-implement
 * the allowlist in a second place, put the parameters back into a URL, and do
 * nothing at all for the OSS `/login` path.
 *
 * FIRST TOUCH WINS: an existing cookie is never overwritten, mirroring Forms.
 * The claim downstream is write-once and cannot be undone, so the browser half
 * has to agree with it.
 */
function parkAttribution(req: NextRequest, res: NextResponse): NextResponse {
  // Never park on an API route. `/api/auth/callback` in particular carries the
  // IDENTITY PROVIDER as its referrer — cross-origin, so it would otherwise be
  // recorded as the acquisition source — on the very request whose handler is
  // deleting this cookie. Two writers on one response is not a race worth
  // having, and no API route is ever an acquisition surface.
  if (req.nextUrl.pathname.startsWith('/api/')) return res;
  if (req.cookies.has(ATTRIBUTION_COOKIE)) return res;

  const attribution = parseAttribution({
    params: req.nextUrl.searchParams,
    refererHeader: req.headers.get('referer'),
    // NOT `req.nextUrl.origin`. Behind the ALB `req.url` reflects the server's
    // bind address (see request-origin.ts), so the same-origin check would fail
    // for internal navigation and every organic signup would be stamped with a
    // self-referral — the exact permanent lie #65 forbids, in the one column
    // that can never be corrected. Local dev would never show it, because
    // there the two happen to match.
    selfOrigin: requestOrigin(req),
  });
  // Organic traffic parks NOTHING. No synthetic `direct`/`organic` — an empty
  // result is the honest representation, and the funnel reads it as such.
  if (!attribution) return res;

  // `SameSite=Lax` means this does NOT park from inside a third-party iframe,
  // which the inline embed (E) made a first-class context. That is the right
  // trade rather than an oversight: `None` would require `Secure` and would
  // send the cookie on every cross-site request, and an embedded booking page
  // is the host's acquisition surface, not ours. So an embed's campaign click
  // is simply not attributed, and the funnel reads that as organic.
  res.cookies.set(ATTRIBUTION_COOKIE, JSON.stringify(attribution), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    maxAge: Math.floor(ATTRIBUTION_WINDOW_MS / 1000),
  });
  return res;
}

/** Where a landing's anonymous id may be parked: the product's own front doors. */
const LANDING_ID_PATH = /^\/(login|onboarding|admin(\/.*)?)?$/;

/**
 * The landing's anonymous analytics id (`?ph_id=`), parked beside the campaign
 * tags for the same login round trip, so the first analytics-bearing page after
 * sign-in (dashboard or wizard) can join "visited the landing" to the host who
 * signed up.
 *
 * Same rules as `parkAttribution` (first touch wins, same ten-minute life),
 * narrower in one way: only on the product's own entry points. Sanitized here, at the edge, because the value is
 * whatever anyone typed into a URL; a refused id parks nothing. Parked whether
 * or not analytics is configured: it is a short-lived first-party cookie that
 * nothing reads unless analytics is on.
 */
function parkLandingId(req: NextRequest, res: NextResponse): NextResponse {
  // Product entry points only. A landing's CTA lands on the root or the
  // sign-in; a booking page is a host's visitors' page and parks nothing.
  if (!LANDING_ID_PATH.test(req.nextUrl.pathname)) return res;
  if (req.cookies.has(LANDING_ID_COOKIE)) return res;
  const landingId = sanitizeLandingDistinctId(req.nextUrl.searchParams.get(LANDING_ID_QUERY_KEY));
  if (!landingId) return res;
  res.cookies.set(LANDING_ID_COOKIE, landingId, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    maxAge: Math.floor(ATTRIBUTION_WINDOW_MS / 1000),
  });
  return res;
}

export function middleware(req: NextRequest) {
  const host = req.headers.get('host')?.toLowerCase().split(':')[0] ?? '';
  const canonical = CANONICAL[host];
  if (canonical) {
    const url = req.nextUrl.clone();
    url.host = canonical;
    url.port = '';
    url.protocol = 'https';
    // Nothing is parked here on purpose: the cookie would be host-only to the
    // alias and never sent to the canonical host. The 308 preserves the query
    // string, so the canonical host's own pass parks the same click.
    return NextResponse.redirect(url, 308);
  }

  // Booking pages on a host of their own (`lib/booking-host.ts`): the booking
  // host bounces the dashboard's paths to the app host, other hosts send public
  // pages there once the redirects are on, and the app host refuses writes a
  // page on another host of the same site made the browser send. Inert while
  // `PUBLIC_BOOKING_URL` is unset.
  const decision = routeForHost({
    host: (req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? '').split(',')[0]!.trim().toLowerCase(),
    method: req.method,
    pathname: req.nextUrl.pathname,
    search: req.nextUrl.search,
    fetchSite: req.headers.get('sec-fetch-site'),
    fetchMode: req.headers.get('sec-fetch-mode'),
    fetchDest: req.headers.get('sec-fetch-dest'),
    purpose: req.headers.get('sec-purpose') ?? req.headers.get('purpose'),
  });
  if (decision.kind === 'redirect') return NextResponse.redirect(decision.url, decision.status);
  if (decision.kind === 'refuse') return new NextResponse(null, { status: decision.status });

  // Tag the request with its own path so the ROOT layout can tell a product
  // route from a booking page and stamp the right `data-theme` before paint.
  // The App Router gives a layout its params and never its path, and the root
  // layout is the only element that can carry the document theme — so the path
  // has to travel as a header. Since B2 the query travels the same way, because
  // an embed's `?theme=` override changes that same answer.
  //
  // Set on the forwarded REQUEST headers: they reach the app and never the
  // browser, which also means headers of these names arriving from a client are
  // overwritten here rather than trusted into the theme decision.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set(PATH_HEADER, req.nextUrl.pathname);
  // Capped: this is attacker-controlled on every request, and the only thing
  // downstream reads out of it is one short enum. `URL` has already
  // percent-encoded any C0 control, so the cap is about size, not injection.
  requestHeaders.set(QUERY_HEADER, req.nextUrl.search.slice(0, 2048));
  // With error tracking on, one id per request, kept when what arrived is
  // safe to echo (as the API does): the response says it (`X-Request-Id`) and
  // an error the server reports for this request carries the same id, so the
  // two meet. Off (every bare fork), no header is added.
  const requestId = errorTrackingOn() ? reportableRequestId(req.headers.get('x-request-id')) : null;
  if (requestId) requestHeaders.set('x-request-id', requestId);
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  if (requestId) res.headers.set('X-Request-Id', requestId);

  // Framing policy, BOTH halves (E, #67). `frame-ancestors *` on the public
  // booking routes is the promise the embed rests on; `'self'` on the admin,
  // on `/manage/[uid]` and on the login/onboarding surfaces is the half that
  // makes the promise safe to make. Before this the repo declared neither, so
  // the dashboard was frameable by any site — by omission.
  for (const [name, value] of Object.entries(framingHeaders(req.nextUrl.pathname))) {
    res.headers.set(name, value);
  }

  // A deployment marked NOINDEX (lib/indexing.ts) says so in a header on every
  // response this runs for, not only in the HTML: the header is what covers the
  // link-preview images, `robots.txt` itself and anything else that is not a
  // page with a `<head>`. (The matcher skips `_next` build assets and the icons,
  // which are nothing a search engine lists.)
  if (deploymentNoindex()) res.headers.set('X-Robots-Tag', NOINDEX_HEADER_VALUE);

  // The booking host keeps no cookie of dCal's: nothing to read there, and a
  // host's own tags share that host.
  if (decision.bookingHost) return res;
  return parkLandingId(req, parkAttribution(req, res));
}

/** Error tracking's runtime switch, from the same settings the rest of analytics reads. */
function errorTrackingOn(): boolean {
  return (
    resolveAnalyticsConfig({
      provider: process.env.PRODUCT_ANALYTICS_PROVIDER,
      key: process.env.PRODUCT_ANALYTICS_KEY,
      host: process.env.PRODUCT_ANALYTICS_HOST,
      errors: process.env.PRODUCT_ANALYTICS_ERRORS,
    })?.errors === true
  );
}

export const config = {
  // Skip static assets; run for pages and API routes.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg|apple-icon.png).*)'],
};
