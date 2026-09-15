import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import { seed } from './seed';
import { createBooking, getAvailability } from './repository';
import { releaseSlot, reserveSlot } from './parity';

/**
 * #135 — `reserveSlot` had no counterpart, so an abandoned pick sat until its
 * ten-minute TTL while `loadReservationBusy` hid that slot from every other
 * visitor. These assert the three properties the release has to hold:
 *
 *  - a released hold really does free the slot for everyone else;
 *  - a release nobody is authorised to make changes nothing and raises nothing,
 *    so it is never an oracle for whether a hold exists;
 *  - a release can never reach a confirmed booking.
 */
describe('releaseSlot (#135)', () => {
  let db: Db;

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
  });

  const WINDOW = () => ({ fromMs: Date.now(), toMs: Date.now() + 10 * 86_400_000 });

  async function slots(): Promise<string[]> {
    const a = await getAvailability(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      ...WINDOW(),
    });
    return (a?.slots ?? []).map((s) => s.startUtc);
  }

  async function hold(startMs: number) {
    const held = await reserveSlot(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      startMs,
    });
    if (!held.ok) throw new Error(`setup: reserve failed (${held.reason})`);
    return held;
  }

  async function reservationCount(uid: string): Promise<number> {
    const row = await db.get<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM slot_reservation WHERE uid = ${uid}`,
    );
    return Number(row?.n ?? 0);
  }

  it('a released hold puts the slot back for every other visitor', async () => {
    const offered = await slots();
    const startUtc = offered[0]!;
    const held = await hold(new Date(startUtc).getTime());

    // The hold hides the slot — this is the behaviour the orphaned holds were
    // leaking onto everyone else.
    expect(await slots()).not.toContain(startUtc);

    await releaseSlot(db, held.uid);

    expect(await slots()).toContain(startUtc);
    expect(await reservationCount(held.uid)).toBe(0);
  });

  it('releasing a hold that is not yours is a silent no-op', async () => {
    const startUtc = (await slots())[0]!;
    const held = await hold(new Date(startUtc).getTime());

    // Anyone can name the slot; only the holder has the uid. A caller guessing
    // at one must not be able to free someone else's hold — or to learn from
    // the outcome that a hold was there at all.
    await expect(releaseSlot(db, randomUUID())).resolves.toBeUndefined();
    await expect(releaseSlot(db, 'not-a-uid')).resolves.toBeUndefined();
    await expect(releaseSlot(db, '')).resolves.toBeUndefined();

    expect(await reservationCount(held.uid)).toBe(1);
    expect(await slots()).not.toContain(startUtc);
  });

  it('releasing the same hold twice is a no-op the second time', async () => {
    const startUtc = (await slots())[0]!;
    const held = await hold(new Date(startUtc).getTime());

    await releaseSlot(db, held.uid);
    await expect(releaseSlot(db, held.uid)).resolves.toBeUndefined();
    expect(await slots()).toContain(startUtc);
  });

  it('releasing an already-expired hold is a no-op', async () => {
    const startUtc = (await slots())[0]!;
    const held = await hold(new Date(startUtc).getTime());
    // Expire it in place rather than waiting out the TTL.
    await db.run(
      sql`UPDATE slot_reservation SET release_at_ms = ${Date.now() - 1_000} WHERE uid = ${held.uid}`,
    );

    await expect(releaseSlot(db, held.uid)).resolves.toBeUndefined();
    expect(await slots()).toContain(startUtc);
  });

  it('a release racing a booking that already consumed the hold cannot free the booked slot', async () => {
    const startUtc = (await slots())[0]!;
    const startMs = new Date(startUtc).getTime();
    const held = await hold(startMs);

    const out = await createBooking(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      startMs,
      attendee: { name: 'Sam', email: 'sam@example.com', timeZone: 'America/New_York' },
      answers: { company: 'Acme' },
      reservationUid: held.uid,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error('setup: booking failed');

    // The booking write consumed the hold. A late release must not read as a
    // failure, and must not hand the slot back — the booking, not the hold, is
    // what keeps it taken now.
    await expect(releaseSlot(db, held.uid)).resolves.toBeUndefined();
    expect(await slots()).not.toContain(startUtc);
  });

  it('a release can never cancel a real booking, even when handed the booking uid', async () => {
    const startUtc = (await slots())[0]!;
    const out = await createBooking(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      startMs: new Date(startUtc).getTime(),
      attendee: { name: 'Sam', email: 'sam@example.com', timeZone: 'America/New_York' },
      answers: { company: 'Acme' },
    });
    expect(out.ok).toBe(true);
    if (!out.ok) throw new Error('setup: booking failed');

    // `slot_reservation` and `booking` are different tables and the release
    // only ever deletes from the first, so a booking uid names nothing here.
    await expect(releaseSlot(db, out.booking.uid)).resolves.toBeUndefined();

    const row = await db.get<{ status: string }>(
      sql`SELECT status FROM booking WHERE uid = ${out.booking.uid}`,
    );
    expect(row?.status).toBe(out.booking.status);
    expect(await slots()).not.toContain(startUtc);
  });
});
