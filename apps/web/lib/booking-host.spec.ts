/**
 * Booking pages on a host of their own, the redirect matrix: what every route
 * type gets on the booking host, on the app host and on an older alias, in
 * each step of the move, and the app host's refusal of writes another host of
 * the same site made the browser send. Nothing at all while unconfigured.
 */
import { describe, expect, it } from 'vitest';
import { bookingOrigin, bookingRedirectMode, isBookingPath, routeForHost } from '@/lib/booking-host';

const APP = 'https://app.dcal.ai';
const BOOK = 'https://book.dcal.ai';
const env = (redirects?: string) => ({ PUBLIC_APP_URL: APP, PUBLIC_BOOKING_URL: BOOK, BOOKING_HOST_REDIRECTS: redirects });
const req = (
  host: string,
  pathname: string,
  over: { method?: string; search?: string; fetchSite?: string; fetchMode?: string; fetchDest?: string; purpose?: string } = {},
) => ({
  host,
  pathname,
  method: over.method ?? 'GET',
  search: over.search ?? '',
  fetchSite: over.fetchSite ?? null,
  fetchMode: over.fetchMode ?? null,
  fetchDest: over.fetchDest ?? null,
  purpose: over.purpose ?? null,
});

/** One of each public route type, with the query an embed or a campaign carries. */
const PUBLIC = [
  ['/acme/alex-rivera', ''],
  ['/acme/alex-rivera/intro-call', '?embed=1&corners=round&utm_source=google&gclid=abc'],
  ['/acme/team/sales', ''],
  ['/acme/team/sales/team-demo', '?lang=es'],
  ['/booking/tok_abc123', ''],
  ['/manage/2c6f0e2e-1b9a-4f53-8d5b-0a1b2c3d4e5f', '?token=t0k3n'],
  ['/uc8ict/felipe/30min', ''],
  ['/acme/alex-rivera/opengraph-image', ''],
] as const;

/** What every host serves as is. */
const SHARED = ['/api/availability', '/_next/static/chunks/app.js', '/embed.js', '/favicon.ico', '/dapta-mark.png', '/robots.txt', '/mcp', '/.well-known/oauth-protected-resource'];
/** The dashboard's. */
const PRODUCT = ['/', '/admin', '/admin/event-types', '/login', '/onboarding', '/auth/join', '/api/auth/login', '/api/auth/logout'];

describe('configuration', () => {
  it('is off unless a booking origin other than the app’s is set', () => {
    expect(bookingOrigin({ PUBLIC_APP_URL: APP })).toBeNull();
    expect(bookingOrigin({ PUBLIC_APP_URL: APP, PUBLIC_BOOKING_URL: 'not a url' })).toBeNull();
    expect(bookingOrigin({ PUBLIC_APP_URL: APP, PUBLIC_BOOKING_URL: `${APP}/` })).toBeNull();
    expect(bookingOrigin(env())).toBe(BOOK);
    expect(bookingRedirectMode({})).toBe('off');
    expect(bookingRedirectMode({ BOOKING_HOST_REDIRECTS: ' Temporary ' })).toBe('temporary');
    expect(bookingRedirectMode({ BOOKING_HOST_REDIRECTS: 'permanent' })).toBe('permanent');
    expect(bookingRedirectMode({ BOOKING_HOST_REDIRECTS: 'yes' })).toBe('off');
  });

  it('changes nothing for any request while unconfigured', () => {
    for (const [path] of PUBLIC) expect(routeForHost(req('app.dcal.ai', path), { PUBLIC_APP_URL: APP })).toEqual({ kind: 'next', bookingHost: false });
    expect(routeForHost(req('app.dcal.ai', '/admin', { method: 'POST', fetchSite: 'same-site' }), { PUBLIC_APP_URL: APP }).kind).toBe('next');
  });

  it('a public path is everything the product does not own and the hosts do not share', () => {
    for (const [path] of PUBLIC) expect(isBookingPath(path)).toBe(true);
    for (const path of [...SHARED, ...PRODUCT]) expect(isBookingPath(path)).toBe(false);
  });
});

describe('the booking host', () => {
  it('serves every public page and every shared path, and keeps no dCal cookie', () => {
    for (const [path, search] of PUBLIC) expect(routeForHost(req('book.dcal.ai', path, { search }), env('temporary'))).toEqual({ kind: 'next', bookingHost: true });
    for (const path of SHARED) expect(routeForHost(req('book.dcal.ai', path), env()).kind).toBe('next');
  });

  it('sends the dashboard’s paths to the app host, path and query kept (temporary, so no browser keeps it), and refuses their writes', () => {
    for (const path of PRODUCT) {
      expect(routeForHost(req('book.dcal.ai', path, { search: '?x=1' }), env())).toEqual({ kind: 'redirect', url: `${APP}${path}?x=1`, status: 307 });
      expect(routeForHost(req('book.dcal.ai', path, { method: 'POST' }), env())).toEqual({ kind: 'refuse', status: 404 });
    }
  });
});

describe('the app host and older aliases', () => {
  it('step 1 (redirects off): still serves public pages, as before', () => {
    for (const [path, search] of PUBLIC) expect(routeForHost(req('app.dcal.ai', path, { search }), env())).toEqual({ kind: 'next', bookingHost: false });
  });

  it('step 2 (temporary): every public GET and HEAD goes to the same path and query on the booking host, with a 307', () => {
    for (const host of ['app.dcal.ai', 'calendar.dapta.ai', 'calendars.dapta.ai']) {
      for (const [path, search] of PUBLIC) {
        for (const method of ['GET', 'HEAD']) {
          // A top-level visit, as a browser that sends Fetch Metadata tells it.
          const top = { search, method, fetchDest: 'document', fetchMode: 'navigate' };
          expect(routeForHost(req(host, path, top), env('temporary'))).toEqual({ kind: 'redirect', url: `${BOOK}${path}${search}`, status: 307 });
        }
      }
    }
  });

  it('never moves a frame: an old embed keeps booking on its host, whatever the customer site’s CSP allows', () => {
    const [path, search] = PUBLIC[1];
    expect(routeForHost(req('app.dcal.ai', path, { search, fetchDest: 'iframe', fetchMode: 'navigate', fetchSite: 'cross-site' }), env('permanent'))).toEqual({ kind: 'next', bookingHost: false });
    // A browser or webview that sends no Fetch Metadata: the snippet's embed mode tells the frame.
    for (const embed of ['?embed=1', '?embed=TRUE&utm_source=x', '?embed=%201%20']) {
      expect(routeForHost(req('app.dcal.ai', path, { search: embed }), env('permanent'))).toEqual({ kind: 'next', bookingHost: false });
    }
    // With Fetch Metadata saying top-level, an embed address opened in a tab moves like any other.
    expect(routeForHost(req('app.dcal.ai', path, { search: '?embed=1', fetchDest: 'document', fetchMode: 'navigate' }), env('permanent'))).toMatchObject({ kind: 'redirect', status: 308 });
    // Not embed mode: moved.
    expect(routeForHost(req('app.dcal.ai', path, { search: '?embed=0' }), env('permanent'))).toMatchObject({ kind: 'redirect', status: 308 });
  });

  it('step 3 (permanent): the same, with a 308', () => {
    const [path, search] = PUBLIC[1];
    expect(routeForHost(req('app.dcal.ai', path, { search, fetchDest: 'document', fetchMode: 'navigate' }), env('permanent'))).toEqual({ kind: 'redirect', url: `${BOOK}${path}${search}`, status: 308 });
    // Without Fetch Metadata, a page that is not an embed moves too.
    const [plain] = PUBLIC[0];
    expect(routeForHost(req('app.dcal.ai', plain), env('permanent'))).toEqual({ kind: 'redirect', url: `${BOOK}${plain}`, status: 308 });
  });

  it('never redirects a POST (an open tab’s Server Action), the dashboard, or a shared path', () => {
    for (const [path] of PUBLIC) expect(routeForHost(req('app.dcal.ai', path, { method: 'POST', fetchSite: 'same-origin' }), env('permanent')).kind).toBe('next');
    for (const path of [...PRODUCT, ...SHARED]) expect(routeForHost(req('app.dcal.ai', path), env('permanent')).kind).toBe('next');
  });

  it('refuses a write another host of the same site made the browser send, and a subresource GET that changes the signed-in state', () => {
    expect(routeForHost(req('app.dcal.ai', '/admin/event-types', { method: 'POST', fetchSite: 'same-site' }), env())).toEqual({ kind: 'refuse', status: 403 });
    for (const path of ['/api/auth/login', '/api/auth/logout', '/api/auth/refresh', '/api/workspace/reset', '/api/developers/skill', '/admin/join/acme']) {
      // An <img> or a fetch from the booking host: refused.
      expect(routeForHost(req('app.dcal.ai', path, { fetchSite: 'same-site', fetchMode: 'no-cors', fetchDest: 'image' }), env())).toEqual({ kind: 'refuse', status: 403 });
      // A frame another host placed is not the person navigating either.
      expect(routeForHost(req('app.dcal.ai', path, { fetchSite: 'same-site', fetchMode: 'navigate', fetchDest: 'iframe' }), env())).toEqual({ kind: 'refuse', status: 403 });
      // A full-page navigation (a click on the landing, the dashboard's own refresh chain): served.
      expect(routeForHost(req('app.dcal.ai', path, { fetchSite: 'same-site', fetchMode: 'navigate', fetchDest: 'document' }), env()).kind).toBe('next');
      // A prerender or prefetch another host's page asked for is not the person navigating.
      expect(routeForHost(req('app.dcal.ai', path, { fetchSite: 'same-site', fetchMode: 'navigate', fetchDest: 'document', purpose: 'prefetch;prerender' }), env())).toEqual({ kind: 'refuse', status: 403 });
      expect(routeForHost(req('app.dcal.ai', path, { fetchSite: 'same-origin' }), env()).kind).toBe('next');
    }
    // Reading is fine: a link from the booking host to the dashboard opens it.
    expect(routeForHost(req('app.dcal.ai', '/admin', { fetchSite: 'same-site' }), env()).kind).toBe('next');
    // Cross-site writes are Next's Server Action check and SameSite's, not this.
    expect(routeForHost(req('app.dcal.ai', '/admin', { method: 'POST', fetchSite: 'cross-site' }), env()).kind).toBe('next');
  });

  it('matches the booking host with its port in development', () => {
    const local = { PUBLIC_APP_URL: 'http://localhost:3000', PUBLIC_BOOKING_URL: 'http://localhost:3001', BOOKING_HOST_REDIRECTS: 'temporary' };
    expect(routeForHost(req('localhost:3001', '/admin'), local)).toEqual({ kind: 'redirect', url: 'http://localhost:3000/admin', status: 307 });
    expect(routeForHost(req('localhost:3000', '/acme/alex-rivera'), local)).toEqual({ kind: 'redirect', url: 'http://localhost:3001/acme/alex-rivera', status: 307 });
  });
});
