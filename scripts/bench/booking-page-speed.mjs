#!/usr/bin/env node
/**
 * Booking page speed bench: how long a visitor waits for the month, and for
 * the first day they can book.
 *
 * Opens the public event page in a fresh browser context, `BENCH_RUNS` times
 * (default 3) at each width, and reports the median of:
 *   - grid: the month grid is in the page (ms from navigation start)
 *   - firstAvailable: the first bookable day is in the grid
 *   - visibleMonthReads: calendar backend reads for windows inside the month
 *     on screen (counted by window, not by time, so a prefetch that starts
 *     the instant the month lands is never mistaken for one of them)
 *   - settledReads: every backend read once the page has been left alone for
 *     4 s (includes the next-month prefetch)
 *   - pageReads: availability requests the browser itself made
 *
 * It needs the fake backend (`fake-calendar-backend.mjs`), an API wired to it
 * (`CALENDAR_PROVIDER=external`, `CALENDAR_API_BASE_URL`) and a production
 * build of the web app (`next build && next start`), plus Playwright, which
 * this repo does not depend on: point `PLAYWRIGHT_MODULE` at an install.
 *
 * Usage:
 *   BENCH_URL=http://localhost:3417/acme/alex-rivera/intro-call \
 *   BENCH_BACKEND=http://localhost:4517 \
 *   PLAYWRIGHT_MODULE=/path/to/node_modules/playwright/index.mjs \
 *   node scripts/bench/booking-page-speed.mjs
 */
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');

const URL_ = process.env.BENCH_URL ?? 'http://localhost:3000/acme/alex-rivera/intro-call';
const BACKEND = process.env.BENCH_BACKEND ?? 'http://localhost:4517';
const RUNS = Number(process.env.BENCH_RUNS ?? 3);
const WIDTHS = (process.env.BENCH_WIDTHS ?? '1440,360').split(',').map(Number);
const SETTLE_MS = 4000;
/** The host's zone (the seeded host), which is the zone the visible month is in. */
const HOST_TZ = process.env.BENCH_HOST_TZ ?? 'America/New_York';

/** The instant the month after the current one starts in HOST_TZ. */
function nextMonthStartMs(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: HOST_TZ, year: 'numeric', month: '2-digit' })
      .formatToParts(now)
      .map((p) => [p.type, Number(p.value)]),
  );
  const wall = Date.UTC(parts.year, parts.month, 1);
  const offsetAt = (ms) => {
    const f = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone: HOST_TZ,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      })
        .formatToParts(new Date(ms))
        .map((p) => [p.type, Number(p.value)]),
    );
    return Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute) - ms;
  };
  const first = wall - offsetAt(wall);
  return wall - offsetAt(first);
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

async function stats() {
  return (await fetch(`${BACKEND}/stats`)).json();
}

/** Marks, in the page's own clock, the moment each thing first appears. */
const MARKER = `
  window.__bench = {};
  const mark = () => {
    const b = window.__bench;
    if (b.grid === undefined && document.querySelector('.bp-cal-grid')) b.grid = performance.now();
    if (b.firstAvailable === undefined && document.querySelector('.bp-cal-day[data-state="available"]')) {
      b.firstAvailable = performance.now();
    }
  };
  new MutationObserver(mark).observe(document, { subtree: true, childList: true, attributes: true });
`;

async function once(browser, width) {
  const height = width < 768 ? 800 : 900;
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  await page.addInitScript(MARKER);
  let pageReads = 0;
  page.on('request', (r) => {
    if (r.url().includes('/api/availability')) pageReads += 1;
  });
  await fetch(`${BACKEND}/reset`, { method: 'POST' });
  await page.goto(URL_, { waitUntil: 'commit' });
  await page.waitForFunction(() => window.__bench?.firstAvailable !== undefined, null, { timeout: 30_000 });
  const marks = await page.evaluate(() => window.__bench);
  await page.waitForTimeout(SETTLE_MS);
  const settled = await stats();
  await context.close();
  const monthEnd = nextMonthStartMs();
  return {
    grid: Math.round(marks.grid),
    firstAvailable: Math.round(marks.firstAvailable),
    visibleMonthReads: settled.windows.filter(([from]) => Date.parse(from) < monthEnd).length,
    settledReads: settled.busyReads,
    pageReads,
  };
}

const browser = await chromium.launch();
const out = {};
for (const width of WIDTHS) {
  await once(browser, width); // warm-up, not counted
  const runs = [];
  for (let i = 0; i < RUNS; i++) runs.push(await once(browser, width));
  out[width] = {
    runs,
    median: {
      grid: median(runs.map((r) => r.grid)),
      firstAvailable: median(runs.map((r) => r.firstAvailable)),
      visibleMonthReads: median(runs.map((r) => r.visibleMonthReads)),
      settledReads: median(runs.map((r) => r.settledReads)),
      pageReads: median(runs.map((r) => r.pageReads)),
    },
  };
}
await browser.close();
console.log(JSON.stringify(out, null, 2));
