import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The server-side client, on a 429. Outside a request there are no visitor
// headers to add (no API_URL set here), so `next/headers` is never reached.
vi.mock('next/headers', () => ({ headers: vi.fn(async () => new Headers()) }));

import { ApiBusyError } from './busy';
import { getManageView, getProfile, postBooking, postReservation } from './api';

const answer = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the web API client on a busy API (429)', () => {
  it('waits out a short Retry-After once, then answers as if nothing happened', async () => {
    const profile = { account: { code: 'acme', name: 'Acme' }, member: { handle: 'alex' }, eventTypes: [] };
    fetchMock
      .mockResolvedValueOnce(answer(429, { error: 'RATE_LIMITED' }, { 'retry-after': '0' }))
      .mockResolvedValueOnce(answer(200, profile));
    expect(await getProfile('acme', 'busy-once')).toEqual(profile);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a long Retry-After is not waited out here: the page gets a busy error carrying the wait', async () => {
    fetchMock.mockResolvedValueOnce(answer(429, { error: 'RATE_LIMITED' }, { 'retry-after': '9' }));
    const err = await getProfile('acme', 'busy-long').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiBusyError);
    expect((err as ApiBusyError).retryAfterMs).toBe(9000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still busy after the one retry: a busy error, never a generic failure', async () => {
    fetchMock.mockImplementation(async () => answer(429, { error: 'RATE_LIMITED' }, { 'retry-after': '0' }));
    await expect(getManageView('uid-1', 'tok')).rejects.toBeInstanceOf(ApiBusyError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a refused booking or hold reports the status, code and wait, for the page to say in its own words', async () => {
    fetchMock.mockImplementation(async () =>
      answer(429, { error: 'RATE_LIMITED', message: 'Too many requests.' }, { 'retry-after': '5' }),
    );
    expect(await postBooking({})).toMatchObject({ ok: false, status: 429, error: 'RATE_LIMITED', retryAfterMs: 5000 });
    expect(await postReservation({ accountCode: 'a', handle: 'b', slug: 'c', startUtc: 'd' })).toMatchObject({
      ok: false,
      status: 429,
      error: 'RATE_LIMITED',
    });
  });

  it('a 429 that names no wait (the cap on a host\'s live holds) is not retried: asking again changes nothing', async () => {
    fetchMock.mockImplementation(async () => answer(429, { error: 'RATE_LIMITED', message: 'Too many active holds.' }));
    expect(await postReservation({ accountCode: 'a', handle: 'b', slug: 'c', startUtc: 'd' })).toMatchObject({
      ok: false,
      status: 429,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('other failures are what they always were', async () => {
    fetchMock.mockResolvedValueOnce(answer(503, {}));
    await expect(getProfile('acme', 'down')).rejects.toThrow('503');
    fetchMock.mockResolvedValueOnce(answer(404, {}));
    expect(await getProfile('acme', 'missing')).toBeNull();
  });
});
