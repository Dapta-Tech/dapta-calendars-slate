import { afterEach, describe, expect, it, vi } from 'vitest';
import { DisabledEntitlementsProvider, HttpEntitlementsProvider } from './entitlements.provider';

/**
 * The HTTP adapter answers `paid` or `free` only from a body it could read.
 * Everything else (a timeout, a network error, a non-2xx status, a body it
 * cannot read) is `unknown`, which the gate never treats as a lapse. It never
 * throws. No real host is called: `fetch` is stubbed.
 */
const BASE = 'https://entitlements.example.test';
const keys = { ownerEmail: 'owner@example.test', externalOrgId: null };

function stubFetch(impl: () => Promise<Response>) {
  const fn = vi.fn(impl);
  vi.stubGlobal('fetch', fn);
  return fn;
}
const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));

afterEach(() => vi.unstubAllGlobals());

describe('HttpEntitlementsProvider', () => {
  const provider = () => new HttpEntitlementsProvider(BASE, 'test-key');

  it('a paying status is paid, in either body shape', async () => {
    stubFetch(() => json([{ account_status_id: 2 }]));
    expect(await provider().verdict(keys)).toBe('paid');
    stubFetch(() => json({ data: [{ account_status_id: 6 }] }));
    expect(await provider().verdict(keys)).toBe('paid');
  });

  it('a readable answer with no paying status is free', async () => {
    stubFetch(() => json([]));
    expect(await provider().verdict(keys)).toBe('free');
    stubFetch(() => json([{ account_status_id: 3 }]));
    expect(await provider().verdict(keys)).toBe('free');
  });

  it('no owner to look up is free, with no call made', async () => {
    const fetch = stubFetch(() => json([]));
    expect(await provider().verdict({ ownerEmail: null })).toBe('free');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('an outage is unknown, never free: 5xx, 429, a timeout, a network error, an unreadable body', async () => {
    stubFetch(() => json({ error: 'down' }, 503));
    expect(await provider().verdict(keys)).toBe('unknown');
    stubFetch(() => json({ error: 'slow down' }, 429));
    expect(await provider().verdict(keys)).toBe('unknown');
    stubFetch(() => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError')));
    expect(await provider().verdict(keys)).toBe('unknown');
    stubFetch(() => Promise.reject(new TypeError('fetch failed')));
    expect(await provider().verdict(keys)).toBe('unknown');
    stubFetch(() => Promise.resolve(new Response('<html>gateway</html>', { status: 200 })));
    expect(await provider().verdict(keys)).toBe('unknown');
    stubFetch(() => json({ unexpected: true }));
    expect(await provider().verdict(keys)).toBe('unknown');
  });
});

describe('DisabledEntitlementsProvider', () => {
  it('is not wired and answers free', async () => {
    const p = new DisabledEntitlementsProvider();
    expect(p.enabled).toBe(false);
    expect(await p.verdict()).toBe('free');
  });
});
