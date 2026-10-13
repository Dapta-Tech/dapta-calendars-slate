/**
 * The booking form carries the hold the page placed when the visitor picked a
 * time (`reservationUid`), and the booking write is what consumes it. The
 * action used to drop it, so every hold outlived its booking for the full ten
 * minutes: a time moved off or cancelled stayed hidden from everyone, and a
 * host's live holds filled the cap of ten, refusing new visitors' holds.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  postBooking: vi.fn(async () => ({ ok: true, status: 201 })),
  postTeamBooking: vi.fn(async () => ({ ok: true, status: 201 })),
  postReservation: vi.fn(),
  postReservationRelease: vi.fn(),
}));
vi.mock('@/lib/api', () => api);

import { bookAction } from './actions';

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
