import { AsyncLocalStorage } from 'node:async_hooks';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * F1 end to end: 40 visitors open a booking page at once, and the web's own
 * server-side API client (lib/api.ts, through visitorFetch and visitorHeaders,
 * with the real X-Forwarded-For hop rule) makes their profile and availability
 * calls against an API that runs the real rate-limit guard with the default
 * limits (burst 60, 1/s). Every call reaches that API from this one process,
 * as every call from the web pod does.
 */

// Each visitor's incoming request, as next/headers would hand it to the server
// code running for that visitor. AsyncLocalStorage keeps 40 concurrent
// visitors apart, the way Next keeps concurrent requests apart.
const request = new AsyncLocalStorage<Headers>();
vi.mock('next/headers', () => ({
  headers: vi.fn(async () => {
    const h = request.getStore();
    if (!h) throw new Error('outside a request');
    return h;
  }),
}));

// The API fixture lives with the API (it needs Nest and its decorators). The
// path is not a literal so this app's typecheck does not compile the API's code.
const FIXTURE = new URL('../../api/src/visitor-rate-limit.fixture.ts', import.meta.url).pathname;
type Fixture = { base: string; close: () => Promise<void> };
type StartPublicApi = (env: Record<string, string>) => Promise<Fixture>;

// A stand-in, at the 32-character minimum the API accepts.
const SECRET = 'test-secret-'.padEnd(32, 'x');
const VISITORS = 40;

// Loading Nest and compiling the fixture is the slow part on a cold cache under
// a full parallel run, so it happens once, here, with room to spare.
const COLD_START_MS = 60_000;
let startPublicApi: StartPublicApi;
beforeAll(async () => {
  ({ startPublicApi } = (await import(/* @vite-ignore */ FIXTURE)) as { startPublicApi: StartPublicApi });
}, COLD_START_MS);

let api: Fixture | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
  delete process.env.API_URL;
  delete process.env.INTERNAL_API_SECRET;
  vi.resetModules();
});

async function fortyVisitorsThroughTheWeb(apiEnv: Record<string, string>, webSecret: string | undefined) {
  api = await startPublicApi(apiEnv);
  process.env.API_URL = api.base;
  if (webSecret) process.env.INTERNAL_API_SECRET = webSecret;
  vi.resetModules();
  const { getAvailability, getProfile } = await import('./api');

  const outcomes = await Promise.all(
    Array.from({ length: VISITORS }, (_, i) =>
      // What the load balancer hands the web: whatever the visitor sent, then
      // the address it saw.
      request.run(new Headers({ 'x-forwarded-for': `10.9.9.9, 198.51.100.${i + 1}` }), async () => {
        const settle = (p: Promise<unknown>) => p.then(() => 'ok', (e: Error) => e.message);
        return [
          await settle(getProfile('acme', `alex-${i}`)),
          await settle(
            getAvailability({
              accountCode: 'acme',
              handle: `alex-${i}`,
              slug: 'intro',
              from: '2026-11-01T00:00:00.000Z',
              to: '2026-12-01T00:00:00.000Z',
            }),
          ),
        ];
      }),
    ),
  );
  const all = outcomes.flat();
  return { ok: all.filter((o) => o === 'ok').length, throttled: all.filter((o) => /429/.test(o)).length };
}

describe('40 visitors through the web client against the rate-limited API (F1)', { timeout: 30_000 }, () => {
  it('with the secret on both apps, every call is answered', async () => {
    const out = await fortyVisitorsThroughTheWeb({ INTERNAL_API_SECRET: SECRET }, SECRET);
    expect(out).toEqual({ ok: 2 * VISITORS, throttled: 0 });
  });

  it('without it, the visitors share the web server bucket and some are throttled', async () => {
    const out = await fortyVisitorsThroughTheWeb({}, undefined);
    expect(out.throttled).toBeGreaterThanOrEqual(2 * VISITORS - 60 - 2);
  });
});
