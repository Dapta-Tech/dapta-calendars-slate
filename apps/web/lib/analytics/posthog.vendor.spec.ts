/**
 * The adapter against the REAL vendor library (the pinned `posthog-js`
 * devDependency's `dist/array.js`, the file the configured host serves), in a
 * window of its own with a hostile URL and referrer. What is asserted is what
 * would leave the browser, read off the library's own requests: the stand-ins
 * elsewhere only prove the app's half, and the vendor adds properties of its
 * own (entry URLs, campaign tags) that only the real thing shows.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { JSDOM, VirtualConsole } from 'jsdom';
import type { AnalyticsConfig } from '@slate/shared';
import { connectPosthog, resetPosthogForTests } from './posthog';

const LIBRARY_PATH = createRequire(import.meta.url).resolve('posthog-js/dist/array.js');
const LIBRARY = readFileSync(LIBRARY_PATH, 'utf8');
/** Where the library asks the configured host for that extension (versioned: `/static/<version>/...`). */
const EXTENSION_PATH = /\/static\/(?:[^/]+\/)?exception-autocapture\.js(\?|$)/;
/** The extension the library loads from the configured host when error capture is on. */
const EXCEPTIONS_EXTENSION = readFileSync(LIBRARY_PATH.replace(/array\.js$/, 'exception-autocapture.js'), 'utf8');
const CONFIG: AnalyticsConfig = { provider: 'posthog', key: 'phc_vendor_test', host: 'https://ingest.example.test', errors: true };
const EMAIL = 'ana.visitor@example.com';
/** Long enough for the library's batch queue (3 s) to flush. */
const FLUSH_MS = 3500;

interface Sent {
  event: string;
  properties: Record<string, unknown>;
  $set?: Record<string, unknown>;
  $set_once?: Record<string, unknown>;
}

/** A browser window with the vendor's transports captured. */
function browser(url: string, referrer?: string) {
  // An uncaught error in the page is what some tests cause on purpose: the
  // page's own handlers see it, the test runner's console does not.
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url,
    ...(referrer ? { referrer } : {}),
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole,
  });
  const w = dom.window as unknown as Window & { eval(code: string): unknown };
  // Scripts the library asks for. The error capture extension is answered
  // with the pinned package's own file, as the configured host would serve
  // it; the library itself is loaded by hand (`load`), so a test controls
  // what is queued before it arrives.
  const scripts: string[] = [];
  new dom.window.MutationObserver((records) => {
    for (const record of records) {
      for (const node of Array.from(record.addedNodes)) {
        const src = (node as HTMLScriptElement).src;
        if ((node as Element).tagName !== 'SCRIPT' || !src) continue;
        scripts.push(src);
        if (EXTENSION_PATH.test(src)) {
          setTimeout(() => {
            w.eval(EXCEPTIONS_EXTENSION);
            (node as HTMLScriptElement).onload?.(new dom.window.Event('load'));
          }, 0);
        }
      }
    }
  }).observe(dom.window.document, { childList: true, subtree: true });
  const bodies: unknown[] = [];
  const urls: string[] = [];
  const record = (u: unknown, body: unknown) => {
    urls.push(String(u));
    bodies.push(body);
  };
  Object.assign(w, {
    fetch: (u: unknown, init?: { body?: unknown }) => {
      record(u, init?.body);
      return Promise.resolve({ status: 200, text: () => Promise.resolve('{}'), json: () => Promise.resolve({}) });
    },
    XMLHttpRequest: class {
      private u = '';
      readyState = 0;
      status = 0;
      responseText = '';
      onreadystatechange: (() => void) | null = null;
      open(_m: string, u: string) {
        this.u = u;
      }
      setRequestHeader() {}
      send(body: unknown) {
        record(this.u, body);
        this.readyState = 4;
        this.status = 200;
        this.responseText = '{}';
        this.onreadystatechange?.();
      }
    },
  });
  w.navigator.sendBeacon = ((u: string, body: unknown) => (record(u, body), true)) as Navigator['sendBeacon'];

  async function sent(): Promise<Sent[]> {
    const out: Sent[] = [];
    for (const body of bodies) {
      if (body == null) continue;
      let buf =
        typeof body === 'string'
          ? Buffer.from(body)
          : typeof (body as Blob).arrayBuffer === 'function'
            ? Buffer.from(await (body as Blob).arrayBuffer())
            : Buffer.from(body as Uint8Array);
      if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);
      let text = buf.toString('utf8');
      if (text.startsWith('data=')) text = Buffer.from(decodeURIComponent(text.slice(5)), 'base64').toString('utf8');
      const parsed = JSON.parse(text) as Sent | Sent[] | { batch: Sent[] };
      out.push(...(Array.isArray(parsed) ? parsed : 'batch' in parsed ? parsed.batch : [parsed]));
    }
    return out;
  }

  /** Throw from the page, outside any handler: what `window.onerror` sees. */
  const throwInPage = (error: Error) =>
    w.setTimeout(() => {
      throw error;
    }, 0);
  /** Until the library has started listening for errors (its extension loaded). */
  const errorCaptureReady = async () => {
    for (let i = 0; i < 100; i++) {
      const ext = (w as unknown as { __PosthogExtensions__?: { errorWrappingFunctions?: unknown } }).__PosthogExtensions__;
      if (ext?.errorWrappingFunctions && typeof w.onerror === 'function') return;
      await wait(20);
    }
    throw new Error(`the error capture extension never loaded; scripts asked for: ${scripts.join(', ')}`);
  };

  return {
    w,
    urls,
    sent,
    scripts,
    throwInPage,
    errorCaptureReady,
    load: () => w.eval(LIBRARY),
    close: () => dom.window.close(),
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Every string anywhere in an event, flattened. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

afterEach(() => resetPosthogForTests());

describe('the PostHog adapter, against the real library', () => {
  it('a visitor event carries nothing personal, no query, no campaign tag, and nothing is stored', async () => {
    const b = browser(
      `https://cal.example.test/acme/ana/intro?prefill=${encodeURIComponent(EMAIL)}&gclid=CLICK123&utm_content=${encodeURIComponent(EMAIL)}#x`,
      'https://crm.example.test/contacts/42?email=bob%40example.com',
    );
    const port = connectPosthog(CONFIG, 'visitor', b.w);
    port.register({ product: 'calendars', surface: 'booking_page', account_code: 'abc123', embed: false });
    port.capture('calendars_booking_page_viewed', { page: 'event' });
    b.load();
    port.capture('calendars_cta_clicked', { utm_medium: 'badge', page: 'event' });
    port.capture('calendars_day_picked', { mode: 'personal', preselected: true });
    await wait(FLUSH_MS);

    const events = await b.sent();
    expect(events.map((e) => e.event)).toEqual([
      'calendars_booking_page_viewed',
      'calendars_cta_clicked',
      'calendars_day_picked',
    ]);
    // Every property this app sends survives the allowlist.
    expect(events[2]!.properties).toMatchObject({ mode: 'personal', preselected: true });
    for (const e of events) {
      const all = strings(e).join(' ');
      expect(all).not.toContain('example.com');
      expect(all).not.toContain('CLICK123');
      expect(all).not.toContain('?');
      expect(e.$set).toBeUndefined();
      expect(e.$set_once).toBeUndefined();
      expect(e.properties['$process_person_profile']).toBe(false);
      expect(e.properties['$referrer']).toBe('https://crm.example.test');
      expect(Object.keys(e.properties).filter((k) => /utm_|gclid|session_entry_url|session_entry_referrer$/.test(k))).toEqual(
        e.event === 'calendars_cta_clicked' ? ['utm_medium'] : [],
      );
    }
    expect(events[1]!.properties['utm_medium']).toBe('badge');
    expect(events[0]!.properties).toMatchObject({ product: 'calendars', account_code: 'abc123', page: 'event' });
    // Only the event endpoint was called: no flags, no remote config, no recording.
    expect(new Set(b.urls.map((u) => new URL(u).pathname))).toEqual(new Set(['/e/']));
    expect(b.w.localStorage.length + b.w.sessionStorage.length).toBe(0);
    expect(b.w.document.cookie).toBe('');
    b.close();
  }, 20_000);

  it('a host is identified, keeps no query or campaign tag, and is never reported off the dashboard', async () => {
    const b = browser(
      'https://cal.example.test/admin/bookings?q=bob%40example.com&utm_source=newsletter',
      'https://crm.example.test/contacts/42?email=bob%40example.com',
    );
    const port = connectPosthog(CONFIG, 'host', b.w);
    port.identify('host@example.test', { email: 'host@example.test', role: 'owner', is_internal: false });
    port.group('calendars_account', 'abc123');
    b.load();
    port.capture('calendars_link_copied');
    // The same tab follows a link to a booking page: nothing more is reported.
    b.w.history.pushState({}, '', '/acme/ana/intro');
    port.capture('calendars_link_copied');
    await wait(FLUSH_MS);

    const events = await b.sent();
    const identify = events.find((e) => e.event === '$identify');
    expect(identify?.$set).toMatchObject({ email: 'host@example.test', role: 'owner' });
    expect(events.filter((e) => e.event === 'calendars_link_copied')).toHaveLength(1);
    for (const e of events) {
      const all = strings(e).join(' ');
      expect(all).not.toContain('bob%40');
      expect(all).not.toContain('newsletter');
      expect(all).not.toContain('?');
      expect(e.properties['$pathname']).not.toBe('/acme/ana/intro');
    }
    b.close();
  }, 20_000);

  it('a landing visit queued before the library loads is joined to the host, not to the anonymous id', async () => {
    // The first page after a signup: the calls are queued before array.js
    // arrives, and the library replays a queued alias before anything else.
    const b = browser('https://cal.example.test/onboarding');
    const port = connectPosthog(CONFIG, 'host', b.w);
    port.identify('host@example.test', { email: 'host@example.test' });
    port.alias('0198a1b2-c3d4-landing', 'host@example.test');
    b.load();
    await wait(FLUSH_MS);
    const alias = (await b.sent()).find((e) => e.event === '$create_alias');
    expect(alias?.properties).toMatchObject({ alias: '0198a1b2-c3d4-landing', distinct_id: 'host@example.test' });
    b.close();
  }, 20_000);

  it("a host arriving from a search result never sends the search engine's keyword", async () => {
    const b = browser('https://cal.example.test/admin', 'https://www.bing.com/search?q=ana+calendly+alternative&form=QBLH');
    const port = connectPosthog(CONFIG, 'host', b.w);
    port.identify('host@example.test', { email: 'host@example.test' });
    b.load();
    port.capture('calendars_link_copied');
    await wait(FLUSH_MS);
    const events = await b.sent();
    expect(events.some((e) => e.event === 'calendars_link_copied')).toBe(true);
    for (const e of events) {
      for (const bag of [e.properties, e.$set, e.$set_once]) {
        expect(Object.keys(bag ?? {}).filter((k) => /ph_keyword|search_engine/.test(k))).toEqual([]);
      }
      expect(strings(e).join(' ')).not.toContain('calendly');
    }
    b.close();
  }, 20_000);

  it("a visitor's uncaught error leaves anonymous, scrubbed, and with nothing from the URL's query", async () => {
    const b = browser(
      `https://cal.example.test/acme/ana/intro?prefill=${encodeURIComponent(EMAIL)}&gclid=CLICK123&utm_content=${encodeURIComponent(EMAIL)}#x`,
      'https://crm.example.test/contacts/42?email=bob%40example.com',
    );
    const port = connectPosthog(CONFIG, 'visitor', b.w);
    port.register({ product: 'calendars', surface: 'booking_page', account_code: 'abc123', embed: false });
    b.load();
    await b.errorCaptureReady();
    b.throwInPage(new Error(`Booking for ${EMAIL} failed, call +57 300 123 4567, see https://x.example.test/p?token=abc`));
    await wait(FLUSH_MS);

    const exception = (await b.sent()).find((e) => e.event === '$exception');
    expect(exception).toBeDefined();
    const props = exception!.properties;
    // Only the allowlist: the vendor's own entry URL, campaign tags and click
    // ids, which it puts on every event, never reach the wire.
    expect(Object.keys(props).filter((k) => /utm_|gclid|session_entry_url|session_entry_referrer$|_steps/.test(k))).toEqual([]);
    expect(props).toMatchObject({
      product: 'calendars',
      surface: 'browser_visitor',
      $host: 'cal.example.test',
      account_code: 'abc123',
      $exception_level: 'error',
    });
    expect(props['$process_person_profile']).toBe(false);
    expect(exception!.$set).toBeUndefined();
    const [entry] = props['$exception_list'] as Array<{
      type: string;
      value: string;
      mechanism: { handled: boolean };
      stacktrace: { frames: Array<{ filename?: string }> };
    }>;
    expect(entry).toMatchObject({
      type: 'Error',
      value: 'Booking for [email] failed, call [phone], see https://x.example.test/p',
      mechanism: { handled: false },
    });
    for (const frame of entry!.stacktrace.frames) expect(frame.filename ?? '').not.toContain('?');
    const all = strings(exception).join(' ');
    expect(all).not.toContain('example.com');
    expect(all).not.toContain('CLICK123');
    expect(all).not.toContain('token=abc');
    // No query string anywhere (an anonymous function is named `?` by the library).
    expect(all).not.toMatch(/\?[\w%.-]+=/);
    // The extension came from the configured host, and nothing was stored.
    expect(b.scripts.some((src) => src.startsWith(`${CONFIG.host}/static/`) && EXTENSION_PATH.test(src))).toBe(true);
    expect(b.w.localStorage.length + b.w.sessionStorage.length).toBe(0);
    b.close();
  }, 20_000);

  it('an error a boundary reports before the library has loaded waits in the queue, and leaves scrubbed', async () => {
    const b = browser('https://cal.example.test/acme/ana/intro');
    const port = connectPosthog(CONFIG, 'visitor', b.w);
    port.captureError(new TypeError(`render failed for ${EMAIL}`), { product: 'calendars', error_boundary: 'booking_page' });
    b.load();
    await wait(FLUSH_MS);
    const exception = (await b.sent()).find((e) => e.event === '$exception');
    expect(exception?.properties).toMatchObject({
      product: 'calendars',
      surface: 'browser_visitor',
      $host: 'cal.example.test',
      error_boundary: 'booking_page',
      $exception_list: [{ type: 'TypeError', value: 'render failed for [email]', mechanism: { handled: true } }],
    });
    expect(strings(exception).join(' ')).not.toContain(EMAIL);
    b.close();
  }, 20_000);

  it("a host's uncaught error is filed under the host, with no query and no campaign tag", async () => {
    const b = browser('https://cal.example.test/admin/bookings?q=bob%40example.com&utm_source=newsletter');
    const port = connectPosthog(CONFIG, 'host', b.w);
    port.identify('host@example.test', { email: 'host@example.test' });
    b.load();
    await b.errorCaptureReady();
    b.throwInPage(new Error('could not load bookings for bob@example.com'));
    await wait(FLUSH_MS);
    const exception = (await b.sent()).find((e) => e.event === '$exception');
    expect(exception?.properties).toMatchObject({
      distinct_id: 'host@example.test',
      product: 'calendars',
      surface: 'browser_host',
      $host: 'cal.example.test',
      $exception_list: [{ value: 'could not load bookings for [email]' }],
    });
    const all = strings(exception).join(' ');
    expect(all).not.toContain('bob');
    expect(all).not.toContain('newsletter');
    expect(all).not.toMatch(/\?[\w%.-]+=/);
    b.close();
  }, 20_000);

  it("the visitor's capture stays silent once the tab has left the booking page", async () => {
    const b = browser('https://cal.example.test/acme/ana/intro');
    connectPosthog(CONFIG, 'visitor', b.w);
    b.load();
    await b.errorCaptureReady();
    b.w.history.pushState({}, '', '/manage/uid-123');
    b.throwInPage(new Error('manage page broke'));
    await wait(FLUSH_MS);
    expect((await b.sent()).filter((e) => e.event === '$exception')).toEqual([]);
    b.close();
  }, 20_000);

  it('with errors off, no error is captured and no extension is loaded', async () => {
    const b = browser('https://cal.example.test/acme/ana/intro');
    const port = connectPosthog({ ...CONFIG, errors: false }, 'visitor', b.w);
    port.captureError(new Error('ignored'));
    b.load();
    port.capture('calendars_day_picked', { mode: 'personal' });
    await wait(100);
    b.throwInPage(new Error('ignored too'));
    await wait(FLUSH_MS);
    const events = await b.sent();
    expect(events.map((e) => e.event)).toEqual(['calendars_day_picked']);
    expect(b.scripts.filter((src) => src.includes('exception-autocapture'))).toEqual([]);
    b.close();
  }, 20_000);

  it('an audience that mounts after the library loaded never orphans the one already running', async () => {
    const b = browser('https://cal.example.test/admin');
    connectPosthog(CONFIG, 'host', b.w);
    b.load();
    // A booking page in the same tab, then back to the dashboard.
    connectPosthog(CONFIG, 'visitor', b.w);
    const port = connectPosthog(CONFIG, 'host', b.w);
    const global = (b.w as unknown as { posthog: Record<string, { __loaded?: boolean }> }).posthog;
    expect(global['calendars_host']?.__loaded).toBe(true);
    expect(global['calendars_visitor']?.__loaded).toBe(true);
    // One library request, however many audiences queued an init.
    expect(b.w.document.querySelectorAll('script[src$="/array.js"]')).toHaveLength(1);
    port.capture('calendars_link_copied');
    await wait(FLUSH_MS);
    expect((await b.sent()).some((e) => e.event === 'calendars_link_copied')).toBe(true);
    b.close();
  }, 20_000);
});
