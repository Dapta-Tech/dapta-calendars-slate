import { NextResponse, type NextRequest } from 'next/server';
import { ATTRIBUTION_COOKIE, ATTRIBUTION_WINDOW_MS, parseAttribution } from '@slate/shared';
import { PATH_HEADER } from '@/lib/theme';
import { requestOrigin } from '@/lib/request-origin';

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

  res.cookies.set(ATTRIBUTION_COOKIE, JSON.stringify(attribution), {
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

  // Tag the request with its own path so the ROOT layout can tell a product
  // route from a booking page and stamp the right `data-theme` before paint.
  // The App Router gives a layout its params and never its path, and the root
  // layout is the only element that can carry the document theme — so the path
  // has to travel as a header.
  //
  // Set on the forwarded REQUEST headers: it reaches the app and never the
  // browser, which also means a header of this name arriving from a client is
  // overwritten here rather than trusted into the theme decision.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set(PATH_HEADER, req.nextUrl.pathname);
  return parkAttribution(req, NextResponse.next({ request: { headers: requestHeaders } }));
}

export const config = {
  // Skip static assets; run for pages and API routes.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
