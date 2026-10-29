import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, type Db } from './client';
import { migrate } from './migrate';
import { seed } from './seed';
import { createBooking, getAvailability } from './repository';
import { rescheduleBookingV2 } from './v2-pilot';
import { getBookingSuccessRedirect, getBookingUtm, getEventTypeById, setBookingUtm, updateEventType } from './crud';

/**
 * `booking.utm` and `event_type.success_redirect_data` on SQLite (Postgres
 * runs the same columns through the API suites): the campaign is written once
 * and never overwritten, survives a v2 reschedule onto the new booking, and a
 * cleared redirect address takes its data choice with it.
 */
describe('booking.utm and success_redirect_data', () => {
  let db: Db;
  let accountId: string;
  let introId: string;

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code='acme'`))!.id;
    introId = (await db.get<{ id: string }>(sql`SELECT id FROM event_type WHERE slug='intro-call'`))!.id;
  });

  async function slots(): Promise<number[]> {
    const a = await getAvailability(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      fromMs: Date.now(),
      toMs: Date.now() + 14 * 86_400_000,
    });
    return a!.slots.map((s) => new Date(s.startUtc).getTime());
  }

  async function book(startMs: number) {
    const out = await createBooking(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      startMs,
      attendee: { name: 'Sam', email: 'sam@example.com', timeZone: 'UTC' },
      answers: { company: 'Example Co' },
    });
    if (!out.ok) throw new Error(`book failed: ${out.reason}`);
    return out.booking.uid;
  }

  it('writes the cleaned campaign once, and never overwrites it', async () => {
    const [start] = await slots();
    const uid = await book(start!);
    expect(await getBookingUtm(db, uid)).toBeNull();
    expect(await setBookingUtm(db, uid, { utm_source: ' google ', gclid: 'x' })).toEqual({ utm_source: 'google' });
    expect(await getBookingUtm(db, uid)).toEqual({ utm_source: 'google' });
    // A second seat on the same row keeps the first campaign.
    await setBookingUtm(db, uid, { utm_source: 'bing' });
    expect(await getBookingUtm(db, uid)).toEqual({ utm_source: 'google' });
    expect(await setBookingUtm(db, uid, { utm_source: '  ' })).toBeNull();
  });

  it('a v2 reschedule carries the campaign to the new booking', async () => {
    const [a, b] = await slots();
    const uid = await book(a!);
    await setBookingUtm(db, uid, { utm_source: 'newsletter', utm_campaign: 'q4' });
    const moved = await rescheduleBookingV2(db, { accountId, uid, newStartMs: b! });
    if (!moved.ok) throw new Error(`reschedule failed: ${moved.reason}`);
    expect(await getBookingUtm(db, moved.uid)).toEqual({ utm_source: 'newsletter', utm_campaign: 'q4' });
  });

  it('a cleared redirect address takes its data choice with it', async () => {
    await updateEventType(db, accountId, introId, { successRedirectUrl: 'https://example.com/thanks', successRedirectData: 'event_and_invitee' });
    expect((await getEventTypeById(db, accountId, introId))!.successRedirectData).toBe('event_and_invitee');
    await updateEventType(db, accountId, introId, { successRedirectUrl: null });
    expect((await getEventTypeById(db, accountId, introId))!.successRedirectData).toBeNull();
    // A later address starts from none, never from the older choice.
    await updateEventType(db, accountId, introId, { successRedirectUrl: 'https://example.com/again' });
    const [start] = await slots();
    const uid = await book(start!);
    expect(await getBookingSuccessRedirect(db, uid)).toMatchObject({ url: 'https://example.com/again', data: null, eventTypeSlug: 'intro-call' });
  });
});
