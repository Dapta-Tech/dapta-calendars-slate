import { afterEach, describe, expect, it } from 'vitest';
import { CLIENT_IP_HEADER, INTERNAL_SECRET_HEADER, visitorForwardHeaders } from '@slate/shared';
import { startPublicApi, type PublicApiFixture } from './visitor-rate-limit.fixture';

/**
 * QA finding F1: the web app calls the API server side, so every visitor of
 * every booking page reached the public limiter from the web server's address
 * and shared one bucket. Here 40 visitors open a booking page at once through
 * the web (two API calls each: profile, then availability), with the default
 * limits (burst 60, 1/s). Every request reaches this API from one socket, as
 * every call from the web pod does. The headers come from the same builder the
 * web uses; apps/web/lib/visitor-through-api.spec.ts drives the web's own API
 * client against this fixture end to end.
 */
// A stand-in, at the 32-character minimum the API accepts.
const SECRET = 'test-secret-'.padEnd(32, 'x');
const VISITORS = 40;

let api: PublicApiFixture | undefined;
afterEach(async () => {
  await api?.close();
  api = undefined;
});

async function startApi(apiEnv: Record<string, string>) {
  api = await startPublicApi(apiEnv);
  return api;
}

/**
 * Each visitor's page view, as the web server makes it: the visitor's address
 * is what the load balancer appended to `X-Forwarded-For` on the way to the web
 * (behind whatever the visitor sent), and `headersFor` is what the web adds to
 * its two API calls. Answers the status of every call.
 */
async function fortyVisitors(base: string, headersFor: (xff: string) => Record<string, string>) {
  const calls = Array.from({ length: VISITORS }, (_, i) => {
    const xff = `10.9.9.9, 198.51.100.${i + 1}`;
    const headers = headersFor(xff);
    return [
      fetch(`${base}/v1/profiles/acme/alex`, { headers }),
      fetch(`${base}/v1/availability`, { headers }),
    ];
  }).flat();
  const statuses = (await Promise.all(calls)).map((r) => r.status);
  return { ok: statuses.filter((s) => s === 200).length, throttled: statuses.filter((s) => s === 429).length };
}

describe('the public rate limiter counts the visitor, not the web server (F1)', () => {
  it('with INTERNAL_API_SECRET on both apps, 40 visitors at once see no 429', async () => {
    const { base } = await startApi({ INTERNAL_API_SECRET: SECRET });
    const out = await fortyVisitors(base, (xff) => visitorForwardHeaders(xff, 1, SECRET));
    expect(out).toEqual({ ok: 2 * VISITORS, throttled: 0 });
  });

  it('with it unset, the old behaviour: one shared bucket, and visitors are throttled', async () => {
    const { base } = await startApi({});
    const out = await fortyVisitors(base, (xff) => visitorForwardHeaders(xff, 1, undefined));
    expect(out.throttled).toBeGreaterThanOrEqual(2 * VISITORS - 60 - 2);
  });

  it('a forged visitor address without the secret opens no new bucket', async () => {
    const { base } = await startApi({ INTERNAL_API_SECRET: SECRET });
    const out = await fortyVisitors(base, (xff) => ({ [CLIENT_IP_HEADER]: xff.split(',').pop()!.trim() }));
    expect(out.throttled).toBeGreaterThanOrEqual(2 * VISITORS - 60 - 2);
  });

  it('nor does one with a wrong secret, which is answered like any request and counted', async () => {
    const { base, guard } = await startApi({ INTERNAL_API_SECRET: SECRET });
    const warned: string[] = [];
    (guard as unknown as { logger: { warn: (m: string) => void } }).logger.warn = (m) => warned.push(m);
    const out = await fortyVisitors(base, (xff) => ({
      [INTERNAL_SECRET_HEADER]: 'not-the-secret',
      [CLIENT_IP_HEADER]: xff.split(',').pop()!.trim(),
    }));
    expect(out.throttled).toBeGreaterThanOrEqual(2 * VISITORS - 60 - 2);
    // 80 wrong secrets inside one minute: one log line, the first.
    expect(warned).toHaveLength(1);
    expect(warned[0]).not.toMatch(/198\.51\.100|not-the-secret/);
  });

  it('an address that is not an IP literal falls back to the socket key', async () => {
    const { base } = await startApi({ INTERNAL_API_SECRET: SECRET });
    let n = 0;
    const out = await fortyVisitors(base, () => ({
      [INTERNAL_SECRET_HEADER]: SECRET,
      [CLIENT_IP_HEADER]: `visitor-${n++}`,
    }));
    expect(out.throttled).toBeGreaterThanOrEqual(2 * VISITORS - 60 - 2);
  });
});
