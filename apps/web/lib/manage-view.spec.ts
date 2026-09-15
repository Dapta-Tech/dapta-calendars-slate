import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getManageView } from './api';

/**
 * The manage read's outcome mapping (#123).
 *
 * `getManageView` used to be `getJson<BookingView>` — an unchecked generic
 * ASSERTION, not a parse — so two different failures both reached a render:
 * a drifted body surfaced as `RangeError: Invalid time value` thrown from
 * `formatSlotDateTime`, and any non-2xx status threw out of `getJson`. Both
 * escaped to the public error boundary, on a page whose only entry point is a
 * link in a confirmation EMAIL: the person who sees the failure has already
 * booked and is trying to cancel or reschedule.
 *
 * What is asserted here is the mapping the page routes on, because that mapping
 * IS the fix — 404 is a real not-found, 403/410 is a dead link (the manage
 * token rotates on every reschedule, so an older emailed link is a 403 BY
 * DESIGN), and a body that parses badly is still handed over rather than turned
 * into a failure.
 */
describe('getManageView outcome mapping (#123)', () => {
  const fetchMock = vi.fn();

  const booking = {
    uid: 'bk_1',
    status: 'accepted',
    title: 'Team Demo',
    startUtc: '2026-09-10T13:00:00.000Z',
    endUtc: '2026-09-10T13:30:00.000Z',
    attendee: { name: 'Sam', email: 'sam@example.com', timeZone: 'America/New_York' },
    host: { name: 'Jordan Lee', handle: 'jordan-lee' },
    reschedule: { kind: 'team', accountCode: 'acme', teamSlug: 'sales', slug: 'team-demo' },
  };

  const respond = (status: number, body: unknown) =>
    fetchMock.mockResolvedValue({
      status,
      ok: status >= 200 && status < 300,
      json: async () => body,
    });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses a 200 body and keeps the team reschedule context', async () => {
    respond(200, booking);
    const res = await getManageView('bk_1', 'tok');

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected ok');
    expect(res.booking.startUtc).toBe('2026-09-10T13:00:00.000Z');
    // The context is what the page picks its availability route from (#122).
    expect(res.booking.reschedule).toEqual({
      kind: 'team',
      accountCode: 'acme',
      teamSlug: 'sales',
      slug: 'team-demo',
    });
  });

  it('reads a v1 personal context, which carried no `kind`', async () => {
    respond(200, {
      ...booking,
      reschedule: { accountCode: 'acme', handle: 'alex-rivera', slug: 'intro-call' },
    });
    const res = await getManageView('bk_1', 'tok');

    if (!res.ok) throw new Error('expected ok');
    expect(res.booking.reschedule).toMatchObject({ handle: 'alex-rivera' });
    expect(res.booking.reschedule).not.toHaveProperty('teamSlug');
  });

  it('maps 404 to not-found, so the page can 404', async () => {
    respond(404, { error: 'NOT_FOUND' });
    expect(await getManageView('bk_1', 'tok')).toEqual({ ok: false, reason: 'not-found' });
  });

  it.each([403, 410])('maps %i to a dead link rather than throwing', async (status) => {
    respond(status, { error: 'FORBIDDEN' });
    // The rotated-token case. This is the one that used to throw into the
    // public error boundary on a perfectly healthy booking.
    await expect(getManageView('bk_1', 'tok')).resolves.toEqual({
      ok: false,
      reason: 'invalid-link',
    });
  });

  it('still throws on a server fault, which is not a dead link', async () => {
    respond(500, {});
    await expect(getManageView('bk_1', 'tok')).rejects.toThrow('500');
  });

  it('hands over a body that does not parse instead of failing the read', async () => {
    // A 200 means the booking exists. Reporting failure for a booking that is
    // fine is exactly what #102 did; the page renders the fields it has.
    respond(200, { uid: 'bk_1', manageUrl: 'https://example.test/manage/bk_1?token=t' });
    const res = await getManageView('bk_1', 'tok');

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('expected ok');
    expect(res.booking.uid).toBe('bk_1');
    // And the page's guard is what keeps an absent instant off `formatSlotDateTime`.
    expect(Number.isNaN(Date.parse(res.booking.startUtc ?? ''))).toBe(true);
  });

  it('token-gates through the query string, escaped', async () => {
    respond(200, booking);
    await getManageView('bk/1', 'a b+c');

    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain('/v1/bookings/bk%2F1');
    expect(url).toContain('token=a%20b%2Bc');
  });
});
