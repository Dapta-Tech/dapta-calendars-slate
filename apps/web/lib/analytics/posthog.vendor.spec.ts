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
import { JSDOM } from 'jsdom';
import type { AnalyticsConfig } from '@slate/shared';
import { connectPosthog, resetPosthogForTests } from './posthog';

const LIBRARY = readFileSync(
  createRequire(import.meta.url).resolve('posthog-js/dist/array.js'),
  'utf8',
);
const CONFIG: AnalyticsConfig = { provider: 'posthog', key: 'phc_vendor_test', host: 'https://ingest.example.test' };
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
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url,
    ...(referrer ? { referrer } : {}),
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const w = dom.window as unknown as Window & { eval(code: string): unknown };
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

  return { w, urls, sent, load: () => w.eval(LIBRARY), close: () => dom.window.close() };
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
    await wait(FLUSH_MS);

    const events = await b.sent();
    expect(events.map((e) => e.event)).toEqual(['calendars_booking_page_viewed', 'calendars_cta_clicked']);
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
    expect(b.w.document.querySelectorAll('script[src$="/static/array.js"]')).toHaveLength(1);
    port.capture('calendars_link_copied');
    await wait(FLUSH_MS);
    expect((await b.sent()).some((e) => e.event === 'calendars_link_copied')).toBe(true);
    b.close();
  }, 20_000);
});
