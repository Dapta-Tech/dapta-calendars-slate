import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { MAX_AVAILABILITY_WINDOW_MS } from '@slate/types';

const api = vi.hoisted(() => ({ getAvailability: vi.fn(), getTeamAvailability: vi.fn() }));
vi.mock('@/lib/api', () => api);

import { GET } from './route';
import { ApiBusyError } from '@/lib/busy';

const FROM = '2026-04-01T04:00:00.000Z';
const TO = '2026-05-01T04:00:00.000Z';

function req(params: Record<string, string>) {
  return new NextRequest(`http://localhost/api/availability?${new URLSearchParams(params).toString()}`);
}
const personal = (extra: Record<string, string> = {}) =>
  req({ kind: 'personal', accountCode: 'acme', owner: 'riley', slug: 'intro', from: FROM, to: TO, ...extra });

const answer = {
  eventType: {
    slug: 'intro',
    title: 'Intro',
    lengthMinutes: 30,
    bookingFields: [{ name: 'company', label: 'Company', type: 'text', required: false }],
    location: null,
  },
  timeZone: 'America/New_York',
  slots: [{ startUtc: '2026-04-06T14:00:00.000Z' }],
};

beforeEach(() => {
  api.getAvailability.mockReset();
  api.getTeamAvailability.mockReset();
});

describe('one window of a public event, for the booking island', () => {
  it('reads exactly the window asked for, from the public personal route, and caches nothing', async () => {
    api.getAvailability.mockResolvedValue(answer);
    const res = await GET(personal());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(api.getAvailability).toHaveBeenCalledWith({ accountCode: 'acme', handle: 'riley', slug: 'intro', from: FROM, to: TO });
    expect(await res.json()).toEqual({ ok: true, slots: answer.slots, bookingFields: answer.eventType.bookingFields });
  });

  it('a team event reads the public team route', async () => {
    api.getTeamAvailability.mockResolvedValue({ ...answer, emptyReason: 'NO_HOSTS', slots: [] });
    const res = await GET(personal({ kind: 'team' }));
    expect(api.getTeamAvailability).toHaveBeenCalledWith({ accountCode: 'acme', teamSlug: 'riley', slug: 'intro', from: FROM, to: TO });
    expect(api.getAvailability).not.toHaveBeenCalled();
    expect(await res.json()).toMatchObject({ ok: true, slots: [], emptyReason: 'NO_HOSTS' });
  });

  it('refuses what the page never asks, before any calendar is read', async () => {
    const bad: Array<Record<string, string>> = [
      { kind: 'machine' },
      { accountCode: '' },
      { slug: 'x'.repeat(201) },
      { from: 'yesterday' },
      { to: FROM },
      { to: new Date(Date.parse(FROM) + MAX_AVAILABILITY_WINDOW_MS + 1).toISOString() },
    ];
    for (const extra of bad) {
      const res = await GET(personal(extra));
      expect(res.status, JSON.stringify(extra)).toBe(400);
    }
    expect(api.getAvailability).not.toHaveBeenCalled();
    expect(api.getTeamAvailability).not.toHaveBeenCalled();
  });

  it('an unknown event is a 404, and an API failure is a window that did not answer', async () => {
    api.getAvailability.mockResolvedValueOnce(null);
    expect((await GET(personal())).status).toBe(404);
    api.getAvailability.mockRejectedValueOnce(new Error('API /v1/availability failed: 503'));
    const res = await GET(personal());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false });
  });

  it('a busy API (429) is passed on as busy with its wait, never as a 502 outage', async () => {
    api.getAvailability.mockRejectedValue(new ApiBusyError(4_000));
    const res = await GET(personal());
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBe('4');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ ok: false, busy: true, retryAfterMs: 4_000 });
  });

  it('any other API failure is still a plain 502', async () => {
    api.getAvailability.mockRejectedValue(new Error('API /v1/availability failed: 500'));
    const res = await GET(personal());
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false });
  });
});
