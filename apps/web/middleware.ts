import { NextResponse, type NextRequest } from 'next/server';

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
  return NextResponse.next();
}

export const config = {
  // Skip static assets; run for pages and API routes.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
