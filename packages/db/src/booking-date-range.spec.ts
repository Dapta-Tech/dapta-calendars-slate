import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import { seed } from './seed';
import { createBooking, getAvailability } from './repository';
import { rescheduleBooking } from './parity';

/**
 * QA fix 8 — no create/reschedule path validated the booking instant, so the
 * server happily stored a booking for 1905 (reproduced live via the host
 * "Any time" form → machine API listed startUtc 1905-02-04). Every write of a
 * booking start now sanity-checks the range: not in the past (5-min grace),
 * not further out than 2 years.
 */
describe('booking start-date sanity (QA fix 8)', () => {
  let db: Db;

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
  });

  const base = {
    accountCode: 'acme',
    handle: 'alex-rivera',
    slug: 'intro-call',
    attendee: { name: 'T', email: 't@example.com', timeZone: 'UTC' },
    answers: { company: 'QA' },
  };

  it('rejects a booking in the distant past (the 1905 case)', async () => {
    const out = await createBooking(db, { ...base, startMs: Date.UTC(1905, 1, 4, 22, 54) });
    expect(out.ok).toBe(false);
    expect((out as { reason: string }).reason).toBe('INVALID');
  });

  it('rejects a booking absurdly far in the future (+5 years)', async () => {
    const out = await createBooking(db, { ...base, startMs: Date.now() + 5 * 365 * 86_400_000 });
    expect(out.ok).toBe(false);
    expect((out as { reason: string }).reason).toBe('INVALID');
  });

  it('accepts a real near-term slot (regression guard)', async () => {
    const a = await getAvailability(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      fromMs: Date.now(),
      toMs: Date.now() + 10 * 86_400_000,
    });
    const out = await createBooking(db, {
      ...base,
      startMs: new Date(a!.slots[0]!.startUtc).getTime(),
    });
    expect(out.ok).toBe(true);
  });

  it('reschedule to an out-of-range instant is rejected too', async () => {
    const a = await getAvailability(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      fromMs: Date.now(),
      toMs: Date.now() + 10 * 86_400_000,
    });
    const created = await createBooking(db, {
      ...base,
      startMs: new Date(a!.slots[0]!.startUtc).getTime(),
    });
    expect(created.ok).toBe(true);
    const uid = (created as { booking: { uid: string } }).booking.uid;
    const moved = await rescheduleBooking(db, {
      uid,
      newStartMs: Date.UTC(1905, 1, 4),
      byHost: true,
    });
    expect(moved.ok).toBe(false);
  });
});
