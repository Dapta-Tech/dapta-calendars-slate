import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, type Db } from './client';
import { migrate } from './migrate';
import { seed } from './seed';
import { createBooking, getAvailability } from './repository';
import { bookingCalendarUid, claimIcsSequence, loadBookingNotificationContext, rescheduleChainRoot } from './parity';

/**
 * The uid the invitee's calendar knows a meeting by. A move through the v2 API
 * or MCP mints a new booking uid and points it back (`rescheduled_from_uid`);
 * every later .ics must keep updating the entry the first booking created
 * (F4 of the 2026-10-30 production E2E: one invitation per booking).
 */
describe('rescheduleChainRoot', () => {
  let db: Db;

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    taken = 0;
  });

  // Each booking takes its own slot, so the duplicate guard never refuses one.
  let taken = 0;
  async function bookOne(): Promise<string> {
    const avail = await getAvailability(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      fromMs: Date.now(),
      toMs: Date.now() + 10 * 86_400_000,
    });
    const startUtc = avail!.slots[taken++]!.startUtc;
    const out = await createBooking(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      startMs: new Date(startUtc).getTime(),
      attendee: { name: 'Sam', email: 'sam@example.com', timeZone: 'UTC' },
      answers: { company: 'Acme' },
    });
    if (!out.ok) throw new Error('setup');
    return out.booking.uid;
  }

  const pointBack = (uid: string, from: string | null) =>
    db.run(sql`UPDATE booking SET rescheduled_from_uid = ${from} WHERE uid = ${uid}`);

  it('a booking never moved to a new uid is its own root', async () => {
    const uid = await bookOne();
    expect(await rescheduleChainRoot(db, uid, null)).toBe(uid);
    expect((await loadBookingNotificationContext(db, uid))!.calendarUid).toBe(uid);
  });

  it('walks a chain of moves back to the first booking', async () => {
    const first = await bookOne();
    const fakeUid = (n: number) => `${first.slice(0, -2)}${String(n).padStart(2, '0')}`;
    // The move: a new booking pointing back at the first one.
    const latest = await bookOne();
    await pointBack(latest, first);
    expect(await rescheduleChainRoot(db, latest, first)).toBe(first);
    expect(await bookingCalendarUid(db, latest)).toBe(first);
    expect(await bookingCalendarUid(db, first)).toBe(first);
    expect((await loadBookingNotificationContext(db, latest))!.calendarUid).toBe(first);
    // A predecessor that no longer exists still names the uid the invitee holds.
    expect(await rescheduleChainRoot(db, latest, fakeUid(7))).toBe(fakeUid(7));
  });

  it('stops on a cycle instead of spinning', async () => {
    const a = await bookOne();
    const b = await bookOne();
    await pointBack(a, b);
    await pointBack(b, a);
    const root = await rescheduleChainRoot(db, a, b);
    expect([a, b]).toContain(root);
  });

  it('claimIcsSequence: one increment per change, never the same number twice', async () => {
    const uid = await bookOne();
    const claimed = await Promise.all([claimIcsSequence(db, uid), claimIcsSequence(db, uid), claimIcsSequence(db, uid)]);
    expect([...claimed].sort()).toEqual([1, 2, 3]);
    expect(await claimIcsSequence(db, 'no-such-booking')).toBeNull();
  });
});
