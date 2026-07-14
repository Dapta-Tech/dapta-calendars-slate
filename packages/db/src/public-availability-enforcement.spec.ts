import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, type Db } from './client';
import { migrate } from './migrate';
import { seed } from './seed';
import { createBooking, getAvailability } from './repository';

/**
 * QA fix 13 (found by the adversarial QA pass on the fix batch): the public
 * POST /v1/bookings path never checked the requested start against the
 * availability engine — an unauthenticated caller could book a host at
 * 3 AM Sunday, or 2 years out on a weekend, by skipping the reservation
 * hold. Public (not on-behalf) bookings without a consumed hold must now
 * land on a genuinely offered slot. Host/agent on-behalf bookings keep the
 * intentional "Any time (outside availability)" override.
 */
describe('public bookings respect availability (QA fix 13)', () => {
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

  /** Next Saturday 15:00 UTC — a valid in-range instant, but outside the
   *  seeded Mon-Fri working hours. */
  function nextSaturdayMs(): number {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + ((6 - d.getUTCDay() + 7) % 7 || 7));
    d.setUTCHours(15, 0, 0, 0);
    return d.getTime();
  }

  it('public booking outside availability is rejected', async () => {
    const out = await createBooking(db, { ...base, startMs: nextSaturdayMs() });
    expect(out.ok).toBe(false);
  });

  it('public booking on a real offered slot still works', async () => {
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

  it('host/agent on-behalf booking outside availability stays allowed (the "Any time" feature)', async () => {
    const out = await createBooking(db, { ...base, startMs: nextSaturdayMs(), onBehalf: true });
    expect(out.ok).toBe(true);
  });
});
