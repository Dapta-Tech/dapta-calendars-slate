import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, type Db } from './client';
import { migrate } from './migrate';
import { seed } from './seed';
import { createBooking, getAvailability } from './repository';
import { rescheduleBookingV2 } from './v2-pilot';
import { claimDueOutbox, enqueueOutbox, listOutbox } from './outbox';

/**
 * A v2 reschedule moves the booking to a NEW uid and hands it the predecessor's
 * still-pending calendar and CRM rows. Those rows are ordered by their booking,
 * so their order key has to follow them: otherwise the successor's own
 * write-out would queue beside them instead of behind them.
 */
describe('outbox order across a v2 reschedule', () => {
  let db: Db;
  let accountId: string;

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code='acme'`))!.id;
  });

  it("the predecessor's pending calendar row keeps its place ahead of the successor's", async () => {
    const a = await getAvailability(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      fromMs: Date.now(),
      toMs: Date.now() + 14 * 86_400_000,
    });
    const [first, second] = a!.slots.map((s) => Date.parse(s.startUtc));
    const booked = await createBooking(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      startMs: first!,
      attendee: { name: 'Sam', email: 'sam-v2-order@example.com', timeZone: 'UTC' },
      answers: { company: 'Acme' },
    });
    if (!booked.ok) throw new Error('seed booking failed');
    const create = await enqueueOutbox(db, { kind: 'calendar', action: 'create', bookingUid: booked.booking.uid, now: 0 });

    const moved = await rescheduleBookingV2(db, { accountId, uid: booked.booking.uid, newStartMs: second! });
    if (!moved.ok) throw new Error(`reschedule failed: ${moved.reason}`);
    const row = (await listOutbox(db)).find((r) => r.id === create)!;
    expect(row.bookingUid).toBe(moved.uid);
    expect(row.orderKey).toBe(moved.uid);

    const move = await enqueueOutbox(db, { kind: 'calendar', action: 'reschedule', bookingUid: moved.uid, now: 1 });
    const opts = { kinds: ['calendar'] as const, inOrder: true };
    expect((await claimDueOutbox(db, 10, 10, opts)).map((r) => r.id)).toEqual([create]);
    expect(move).toBeTruthy();
  });
});
