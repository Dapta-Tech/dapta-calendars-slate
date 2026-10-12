import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The incoming request as the web server sees it: whatever the visitor sent,
// then the address the load balancer appended.
let incoming: Headers | null = new Headers({ 'x-forwarded-for': '9.9.9.9, 203.0.113.7' });
vi.mock('next/headers', () => ({
  headers: vi.fn(async () => {
    if (!incoming) throw new Error('outside a request');
    return incoming;
  }),
}));

import {
  getAvailability,
  getManageView,
  getOneOffLink,
  getProfile,
  getRescheduleAvailability,
  getTeamAvailability,
  getTeamProfile,
  postBooking,
  postManage,
  postReservation,
  postReservationRelease,
  postTeamBooking,
} from './api';

// A stand-in, at the 32-character minimum the API accepts.
const SECRET = 'test-secret-'.padEnd(32, 'x');
const sent: Array<{ url: string; headers: Record<string, string> }> = [];

beforeEach(() => {
  sent.length = 0;
  incoming = new Headers({ 'x-forwarded-for': '9.9.9.9, 203.0.113.7' });
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    sent.push({ url, headers: { ...(init.headers as Record<string, string>) } });
    return new Response('{}', { status: 404 });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.INTERNAL_API_SECRET;
  delete process.env.RATE_LIMIT_TRUSTED_PROXY_HOPS;
});

/** Every server-side call the web makes on a visitor's behalf. */
async function everyVisitorCall() {
  const swallow = (p: Promise<unknown>) => p.catch(() => undefined);
  const range = { from: '2026-11-01T00:00:00.000Z', to: '2026-12-01T00:00:00.000Z' };
  await swallow(getProfile('acme', 'alex'));
  await swallow(getTeamProfile('acme', 'sales'));
  await swallow(getAvailability({ accountCode: 'acme', handle: 'alex', slug: 'intro', ...range }));
  await swallow(getTeamAvailability({ accountCode: 'acme', teamSlug: 'sales', slug: 'demo', ...range }));
  await swallow(getRescheduleAvailability({ uid: 'b1', token: 't', ...range }));
  await swallow(postReservation({ accountCode: 'acme', handle: 'alex', slug: 'intro', startUtc: range.from } as never));
  await swallow(postReservationRelease('r1'));
  await swallow(postBooking({}));
  await swallow(postTeamBooking('acme', 'sales', {}));
  await swallow(getManageView('b1', 't'));
  await swallow(postManage('b1', 't', 'cancel', {}));
  await swallow(getOneOffLink('tok'));
}

describe('server-side visitor calls forward the visitor to the API (F1)', () => {
  it('with INTERNAL_API_SECRET set, every call carries the secret and the address the load balancer saw', async () => {
    process.env.INTERNAL_API_SECRET = SECRET;
    await everyVisitorCall();
    expect(sent).toHaveLength(12);
    for (const call of sent) {
      expect(call.headers['x-slate-internal'], call.url).toBe(SECRET);
      expect(call.headers['x-slate-client-ip'], call.url).toBe('203.0.113.7');
    }
  });

  it("keeps each call's own headers beside them", async () => {
    process.env.INTERNAL_API_SECRET = SECRET;
    await getRescheduleAvailability({ uid: 'b1', token: 'manage-t', from: 'a', to: 'b' });
    expect(sent[0]!.headers['x-manage-token']).toBe('manage-t');
    expect(sent[0]!.headers['x-slate-client-ip']).toBe('203.0.113.7');
  });

  it('reads the hop count the API reads: two proxies, the address the outer one saw', async () => {
    process.env.INTERNAL_API_SECRET = SECRET;
    process.env.RATE_LIMIT_TRUSTED_PROXY_HOPS = '2';
    incoming = new Headers({ 'x-forwarded-for': '9.9.9.9, 203.0.113.7, 10.0.0.2' });
    await postReservationRelease('r1');
    expect(sent[0]!.headers['x-slate-client-ip']).toBe('203.0.113.7');
  });

  it('sends nothing new when the secret is unset, outside a request, or with no forwarded address', async () => {
    await everyVisitorCall();
    process.env.INTERNAL_API_SECRET = SECRET;
    incoming = null;
    await postReservationRelease('r1');
    incoming = new Headers();
    await postReservationRelease('r1');
    for (const call of sent) {
      expect(call.headers['x-slate-internal']).toBeUndefined();
      expect(call.headers['x-slate-client-ip']).toBeUndefined();
    }
  });
});
