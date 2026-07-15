import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import { seed } from './seed';
import { createBooking, getAvailability } from './repository';
import { cancelBooking } from './parity';
import { updateEventType } from './crud';

/**
 * QA fix 3 — an agent that books via the machine API could not retract its
 * own PENDING booking: cancelBooking only accepted status 'accepted' and
 * answered GONE ("Booking is no longer active" — false) for pendings. The
 * only path out was the logged-in host's decline. Cancelling a pending is
 * now allowed for both the host surface and the manage-token surface.
 */
describe('cancel a pending booking (QA fix 3)', () => {
  let db: Db;
  let accountId: string;

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code='acme'`))!.id;
    // Make the seeded event require confirmation → bookings are born pending.
    const et = (await db.get<{ id: string }>(
      sql`SELECT id FROM event_type WHERE slug='intro-call' LIMIT 1`,
    ))!;
    await updateEventType(db, accountId, et.id, { requiresConfirmation: true });
  });

  async function bookPending(): Promise<{ uid: string; token: string }> {
    const a = await getAvailability(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      fromMs: Date.now(),
      toMs: Date.now() + 10 * 86_400_000,
    });
    const out = await createBooking(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      startMs: new Date(a!.slots[0]!.startUtc).getTime(),
      attendee: { name: 'Pending Pat', email: 'pat@example.com', timeZone: 'UTC' },
      answers: { company: 'QA Co' },
    });
    expect(out.ok).toBe(true);
    const o = out as { booking: { uid: string; status: string }; manageToken: string };
    expect(o.booking.status).toBe('pending');
    return { uid: o.booking.uid, token: o.manageToken };
  }

  it('host surface (byHost) can cancel a pending booking', async () => {
    const { uid } = await bookPending();
    const res = await cancelBooking(db, { uid, byHost: true, accountId, reason: 'agent retract' });
    expect(res.ok).toBe(true);
    const row = await db.get<{ status: string }>(sql`SELECT status FROM booking WHERE uid = ${uid}`);
    expect(row!.status).toBe('cancelled');
  });

  it('attendee manage-token can cancel a pending booking', async () => {
    const { uid, token } = await bookPending();
    const res = await cancelBooking(db, { uid, manageToken: token });
    expect(res.ok).toBe(true);
    const row = await db.get<{ status: string }>(sql`SELECT status FROM booking WHERE uid = ${uid}`);
    expect(row!.status).toBe('cancelled');
  });

  it('cancel stays idempotent and still refuses rejected bookings', async () => {
    const { uid } = await bookPending();
    await cancelBooking(db, { uid, byHost: true, accountId });
    const again = await cancelBooking(db, { uid, byHost: true, accountId });
    expect(again.ok).toBe(true); // idempotent retry
    expect((again as { alreadyApplied?: boolean }).alreadyApplied).toBe(true);

    const { uid: uid2 } = await bookPending();
    await db.run(sql`UPDATE booking SET status = 'rejected' WHERE uid = ${uid2}`);
    const rejected = await cancelBooking(db, { uid: uid2, byHost: true, accountId });
    expect(rejected.ok).toBe(false); // declined stays GONE
  });
});
