/**
 * The booking form carries the hold the page placed when the visitor picked a
 * time (`reservationUid`), and the booking write is what consumes it. The
 * action used to drop it, so every hold outlived its booking for the full ten
 * minutes: a time moved off or cancelled stayed hidden from everyone, and a
 * host's live holds filled the cap of ten, refusing new visitors' holds.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  getManageView: vi.fn(),
  postBooking: vi.fn(async () => ({ ok: true, status: 201 })),
  postTeamBooking: vi.fn(async () => ({ ok: true, status: 201 })),
  postReservation: vi.fn(),
  postReservationRelease: vi.fn(),
}));
vi.mock('@/lib/api', () => api);

import { bookAction, meetingLinkAction } from './actions';

const HOLD = '6f1c2b7e-1d2a-4c3b-9e8f-0a1b2c3d4e5f';

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries({
    accountCode: 'acme',
    ownerSlug: 'alex-rivera',
    slug: 'intro-call',
    kind: 'personal',
    startUtc: '2026-10-14T14:30:00.000Z',
    timeZone: 'America/New_York',
    name: 'Ada Visitor',
    email: 'ada@example.test',
    ...fields,
  }))
    f.set(k, v);
  return f;
}

beforeEach(() => {
  api.postBooking.mockClear();
  api.postTeamBooking.mockClear();
});

describe('bookAction hands the hold to the booking that consumes it', () => {
  it('forwards the form reservationUid on a personal booking', async () => {
    await bookAction(null, form({ reservationUid: HOLD }));
    expect(api.postBooking).toHaveBeenCalledTimes(1);
    expect(api.postBooking).toHaveBeenCalledWith(
      expect.objectContaining({ startUtc: '2026-10-14T14:30:00.000Z', reservationUid: HOLD }),
      undefined,
    );
  });

  it('books without one when the page holds nothing (a refused or skipped hold)', async () => {
    await bookAction(null, form({}));
    const body = (api.postBooking.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(body['reservationUid']).toBeUndefined();
    await bookAction(null, form({ reservationUid: '' }));
    const empty = (api.postBooking.mock.calls[1] as unknown[])[0] as Record<string, unknown>;
    expect(empty['reservationUid']).toBeUndefined();
  });

  it('keeps the one-off token on the header, beside the hold', async () => {
    await bookAction(null, form({ reservationUid: HOLD, oneOffToken: 'tok_1' }));
    expect(api.postBooking).toHaveBeenCalledWith(expect.objectContaining({ reservationUid: HOLD }), 'tok_1');
  });

  it('a team booking places no hold, and sends none', async () => {
    await bookAction(null, form({ kind: 'team', ownerSlug: 'sales', slug: 'team-demo', reservationUid: HOLD }));
    expect(api.postBooking).not.toHaveBeenCalled();
    const body = (api.postTeamBooking.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
    expect(body['reservationUid']).toBeUndefined();
  });
});

describe("bookAction sends the page's language as the booking's (F6)", () => {
  const bodyOf = (call: unknown[] | undefined, at: number) =>
    (call as unknown[])[at] as { locale?: string; attendee: Record<string, unknown> };

  it('on a personal and a team booking, as `locale`, never as a contact property', async () => {
    await bookAction(null, form({ language: 'es' }));
    expect(bodyOf(api.postBooking.mock.calls[0], 0).locale).toBe('es');
    await bookAction(null, form({ kind: 'team', ownerSlug: 'sales', slug: 'team-demo', language: 'en' }));
    expect(bodyOf(api.postTeamBooking.mock.calls[0], 2).locale).toBe('en');
    // `attendee.language` feeds the CRM write-out; the page leaves it alone.
    expect(bodyOf(api.postBooking.mock.calls[0], 0).attendee).not.toHaveProperty('language');
    expect(bodyOf(api.postTeamBooking.mock.calls[0], 2).attendee).not.toHaveProperty('language');
  });

  it('leaves out anything but en and es, so the API keeps the host language', async () => {
    await bookAction(null, form({ language: 'fr' }));
    await bookAction(null, form({}));
    for (const call of api.postBooking.mock.calls) {
      expect(bodyOf(call, 0).locale).toBeUndefined();
    }
  });
});

describe('meetingLinkAction answers the join link and nothing else (F5)', () => {
  it('the link once the booking has one', async () => {
    api.getManageView.mockResolvedValueOnce({
      ok: true,
      booking: { uid: 'bk', meetingUrl: 'https://meet.example.test/evt_1', attendee: { email: 'x@example.test' } },
    });
    await expect(meetingLinkAction('bk', 'tok')).resolves.toBe('https://meet.example.test/evt_1');
    expect(api.getManageView).toHaveBeenCalledWith('bk', 'tok');
  });

  it('null while there is none, for a dead link, an error, or anything not http(s)', async () => {
    api.getManageView.mockResolvedValueOnce({ ok: true, booking: { uid: 'bk', meetingUrl: null } });
    await expect(meetingLinkAction('bk', 'tok')).resolves.toBeNull();
    api.getManageView.mockResolvedValueOnce({ ok: false, reason: 'invalid-link' });
    await expect(meetingLinkAction('bk', 'tok')).resolves.toBeNull();
    api.getManageView.mockRejectedValueOnce(new Error('API down'));
    await expect(meetingLinkAction('bk', 'tok')).resolves.toBeNull();
    api.getManageView.mockResolvedValueOnce({ ok: true, booking: { uid: 'bk', meetingUrl: 'javascript:alert(1)' } });
    await expect(meetingLinkAction('bk', 'tok')).resolves.toBeNull();
  });

  it('asks nothing for an empty or oversized credential', async () => {
    api.getManageView.mockClear();
    await expect(meetingLinkAction('', 'tok')).resolves.toBeNull();
    await expect(meetingLinkAction('bk', 'x'.repeat(600))).resolves.toBeNull();
    expect(api.getManageView).not.toHaveBeenCalled();
  });
});

describe('bookAction forwards the campaign the page carried', () => {
  it('the five utm_* fields, cleaned, on a personal booking', async () => {
    await bookAction(null, form({ utm_source: ' google ', utm_campaign: 'q4', utm_medium: '', gclid: 'abc' }));
    expect(api.postBooking).toHaveBeenCalledWith(
      expect.objectContaining({ utm: { utm_source: 'google', utm_campaign: 'q4' } }),
      undefined,
    );
  });

  it('on a team booking too', async () => {
    await bookAction(null, form({ kind: 'team', utm_source: 'linkedin' }));
    expect(api.postTeamBooking).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ utm: { utm_source: 'linkedin' } }),
      undefined,
    );
  });

  it('nothing when the page carried none', async () => {
    await bookAction(null, form({}));
    expect(api.postBooking).toHaveBeenCalledWith(expect.not.objectContaining({ utm: expect.anything() }), undefined);
  });
});
