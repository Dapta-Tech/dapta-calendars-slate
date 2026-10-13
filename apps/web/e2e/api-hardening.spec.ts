import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { E2E, HOST } from './stack';

/**
 * The hardening, checked on the API process itself (main.ts, as production
 * boots it) rather than on a fixture app: security headers on every kind of
 * answer, the public rate limiter's 429 and Retry-After, a spoofed
 * X-Forwarded-For that cannot buy a fresh bucket, and request log lines that
 * carry no visitor data.
 *
 * Runs once (desktop project), after the browser files have booked, moved and
 * cancelled, so the log holds a full booking life.
 */
const SECURITY = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};

const window = () => {
  const from = new Date(Date.now() + 86_400_000);
  return { from: from.toISOString(), to: new Date(from.getTime() + 7 * 86_400_000).toISOString() };
};

test('security headers on every kind of answer, and no X-Powered-By', async ({ request }) => {
  const calls: Array<[string, () => Promise<{ status(): number; headers(): Record<string, string> }>]> = [
    ['health', () => request.get(`${E2E.api}/health`)],
    ['public 200', () => request.get(`${E2E.api}/v1/profiles/${HOST.accountCode}/${HOST.handle}`)],
    ['availability 200', () => request.get(`${E2E.api}/v1/availability`, { params: { ...HOST, ...window() } })],
    ['public 404', () => request.get(`${E2E.api}/v1/profiles/${HOST.accountCode}/nobody-here`)],
    ['validation 400', () => request.get(`${E2E.api}/v1/availability`, { params: { accountCode: 'acme' } })],
    ['manage 403/404', () => request.get(`${E2E.api}/v1/bookings/00000000-0000-0000-0000-000000000000?token=x`)],
    ['admin 200', () => request.get(`${E2E.api}/v1/event-types`, { headers: { 'x-slate-email': HOST.email } })],
    ['unmatched 404', () => request.get(`${E2E.api}/no/such/route`)],
    [
      'malformed JSON',
      () =>
        request.post(`${E2E.api}/v1/bookings`, { headers: { 'content-type': 'application/json' }, data: '{"oops":' }),
    ],
    [
      'oversize body 413',
      () =>
        request.post(`${E2E.api}/v1/bookings`, {
          headers: { 'content-type': 'application/json' },
          data: JSON.stringify({ pad: 'x'.repeat(200_000) }),
        }),
    ],
  ];
  for (const [label, call] of calls) {
    const r = await call();
    const h = r.headers();
    for (const [k, v] of Object.entries(SECURITY)) expect(h[k], `${label} (${r.status()}): ${k}`).toBe(v);
    expect(h['x-powered-by'], `${label}: x-powered-by`).toBeUndefined();
    expect(h['x-request-id'], `${label}: x-request-id`).toMatch(/^[A-Za-z0-9._:-]{1,100}$/);
  }
});

test.describe('the public rate limiter', () => {
  // A second API on the same database, with a bucket of five and a slow refill.
  // One trusted proxy hop, as a deployment behind one load balancer sets it.
  const profile = `${E2E.limitedApi}/v1/profiles/${HOST.accountCode}/${HOST.handle}`;

  test('one client past the limit gets 429 with Retry-After', async ({ request }) => {
    const client = '198.51.100.10';
    const statuses: number[] = [];
    let retryAfter: string | undefined;
    for (let i = 0; i < 8; i++) {
      const r = await request.get(profile, { headers: { 'x-forwarded-for': client } });
      statuses.push(r.status());
      if (r.status() === 429) retryAfter = r.headers()['retry-after'];
    }
    expect(statuses.slice(0, 5).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(5)).toEqual([429, 429, 429]);
    expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
  });

  test('a spoofed X-Forwarded-For prefix does not buy a fresh bucket', async ({ request }) => {
    // The load balancer appends the real client last; whatever the client wrote
    // before it is not trusted. Rotating that prefix must not reset the limit.
    const real = '198.51.100.20';
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) {
      const spoof = `203.0.113.${i + 1}`;
      const r = await request.get(profile, { headers: { 'x-forwarded-for': `${spoof}, ${real}` } });
      statuses.push(r.status());
    }
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(3);
  });

  test('another client keeps its own bucket', async ({ request }) => {
    const r = await request.get(profile, { headers: { 'x-forwarded-for': '198.51.100.30' } });
    expect(r.status()).toBe(200);
  });
});

test('request log lines carry no visitor data', async () => {
  const log = readFileSync(resolve(E2E.logDir, 'main.log'), 'utf8').replace(/\x1b\[[0-9;]*m/g, '');
  const requestLines = log.split('\n').filter((l) => l.startsWith('[http] '));
  // The browser files booked, moved and cancelled through this API.
  expect(requestLines.some((l) => l.includes('POST /v1/bookings 201'))).toBe(true);
  expect(requestLines.some((l) => /POST \/v1\/bookings\/:uid\/(reschedule|cancel) 20\d/.test(l))).toBe(true);
  for (const line of requestLines) {
    expect(line, line).not.toMatch(/@/); // no email, visitor's or host's
    expect(line, line).not.toMatch(/token=|[?&]from=/); // no query string
    expect(line, line).not.toMatch(/Ada Visitor|Example Co/); // no body content
    expect(line, line).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|::1|::ffff:/); // no client address
    expect(line, line).not.toMatch(/\/v1\/bookings\/[0-9a-f-]{36}/); // the route template, not the uid
  }
});
