import { NextResponse, type NextRequest } from 'next/server';
import { PATH_HEADER } from '@/lib/theme';

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

export function middleware(req: NextRequest) {
  const host = req.headers.get('host')?.toLowerCase().split(':')[0] ?? '';
  const canonical = CANONICAL[host];
  if (canonical) {
    const url = req.nextUrl.clone();
    url.host = canonical;
    url.port = '';
    url.protocol = 'https';
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
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  // Skip static assets; run for pages and API routes.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
