/**
 * Which of the host's tags a booking page may start, and where, for every
 * combination of the API's booking origin (`trackingHostScriptsOrigin`) and
 * this web's own (`PUBLIC_BOOKING_URL`): Google Tag Manager, Google Analytics
 * and HubSpot run only on a booking host both name, and their ids never reach
 * the page while the two disagree. And the wiring: every page that renders
 * `EventTracking` takes its props from here.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bookingPageTracking, resetBookingPageTrackingWarningForTests } from '@/lib/booking-page-tracking';

const APP = 'https://app.dcal.ai';
const BOOK = 'https://book.dcal.ai';
const ALL = { gtmId: 'GTM-AB12', ga4Id: 'G-AB12CD34', hubspotTrackingId: '7', metaPixelId: '424242424242' };
const VENDOR_ONLY = { metaPixelId: '424242424242' };
const web = (booking?: string) => ({ PUBLIC_APP_URL: APP, ...(booking !== undefined ? { PUBLIC_BOOKING_URL: booking } : {}) });

afterEach(() => {
  vi.restoreAllMocks();
  resetBookingPageTrackingWarningForTests();
});

describe('bookingPageTracking', () => {
  it('neither names a booking host (one origin, a fork): the ids as the allowlist let them through, anywhere', () => {
    expect(bookingPageTracking({ tracking: ALL }, web())).toEqual({ tracking: ALL, hostScriptsOrigin: null });
    expect(bookingPageTracking({ tracking: ALL, trackingHostScriptsOrigin: null }, web(`${APP}/`))).toEqual({ tracking: ALL, hostScriptsOrigin: null });
  });

  it('only this web names it: the allowlist still decides, on the booking host only', () => {
    expect(bookingPageTracking({ tracking: ALL }, web(BOOK))).toEqual({ tracking: ALL, hostScriptsOrigin: BOOK });
  });

  it('both name the same one: on the booking host only', () => {
    expect(bookingPageTracking({ tracking: ALL, trackingHostScriptsOrigin: BOOK }, web(`${BOOK}/`))).toEqual({ tracking: ALL, hostScriptsOrigin: BOOK });
  });

  it('only the API, or the two apart: GTM, GA4 and HubSpot never reach the page; Meta and PostHog stay', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const [api, env] of [
      [BOOK, web()], // the API rolled first
      [BOOK, web(`${APP}/`)], // this web set to its own app origin
      ['https://other.dcal.ai', web(BOOK)], // a typo on one side
      [APP, web(BOOK)], // an API that names the app host
    ] as const) {
      expect(bookingPageTracking({ tracking: ALL, trackingHostScriptsOrigin: api }, env)).toEqual({ tracking: VENDOR_ONLY, hostScriptsOrigin: null });
    }
    expect(bookingPageTracking({ tracking: { gtmId: 'GTM-AB12' }, trackingHostScriptsOrigin: BOOK }, web())).toEqual({ tracking: null, hostScriptsOrigin: null });
    // Said once, so a mismatch is not just a silent dead tag.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain(BOOK);
  });

  it('no tracking at all: nothing, wherever', () => {
    expect(bookingPageTracking({}, web(BOOK))).toEqual({ tracking: null, hostScriptsOrigin: BOOK });
  });
});

describe('every page that renders EventTracking takes its props from bookingPageTracking', () => {
  // Every module of the web that imports the component (by any name), wherever
  // it lives: only the three event pages may, and each render goes through the
  // helper, so no page can hand it raw ids and a null origin.
  const webDir = join(__dirname, '..');
  const SOURCE_DIRS = ['app', 'components', 'lib', 'types'];
  const importsComponent = /from\s+['"][^'"]*components\/event-tracking['"]/;
  const files = SOURCE_DIRS.flatMap((dir) =>
    (readdirSync(join(webDir, dir), { recursive: true }) as string[]).map((f) => `${dir}/${f.split(sep).join('/')}`),
  );
  const rendering = [...files, 'middleware.ts', 'instrumentation.ts']
    .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.spec\.tsx?$/.test(f) && f !== 'components/event-tracking.tsx')
    .filter((f) => importsComponent.test(readFileSync(join(webDir, f), 'utf8')));

  it('finds the three event pages (personal, team, one-off link), and nothing else', () => {
    expect(rendering.sort()).toEqual([
      'app/[accountCode]/[handle]/[slug]/page.tsx',
      'app/[accountCode]/team/[teamSlug]/[slug]/page.tsx',
      'app/booking/[token]/page.tsx',
    ]);
  });

  it.each(rendering)('%s', (page) => {
    const source = readFileSync(join(webDir, page), 'utf8');
    expect(source).toMatch(/import \{ EventTracking \} from '@\/components\/event-tracking';/);
    expect(source).not.toMatch(/createElement\(\s*EventTracking/);
    const renders = source.match(/<EventTracking\b[^>]*>/g) ?? [];
    expect(renders.length).toBeGreaterThan(0);
    for (const tag of renders) expect(tag).toMatch(/^<EventTracking \{\.\.\.bookingPageTracking\([\w.]+\)\} \/>$/);
  });
});
