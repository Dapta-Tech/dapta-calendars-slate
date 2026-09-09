import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { isExclusionViolation } from '@slate/engine';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import { seed } from './seed';
import { createBooking, getAvailability, getMember, getAccountByCode } from './repository';
import {
  addGuestsToBooking,
  claimApiIdempotency,
  completeApiIdempotency,
  rescheduleBookingV2,
} from './v2-pilot';

// The Postgres path is the SOURCE OF TRUTH — CI runs this on a real Postgres on
// every PR. It proves BOTH the app-level guard and the DB-level EXCLUDE
// constraint reject double-bookings. Skipped locally on the SQLite dev default.
const url = process.env.DATABASE_URL ?? '';
const isPg = url.startsWith('postgres://') || url.startsWith('postgresql://');
const describePg = isPg ? describe : describe.skip;

describePg('repository (real Postgres — the tested truth)', () => {
  let db: Db;

  beforeAll(async () => {
    db = await createDb(url);
    await migrate(db);
    // Seed ONLY if the demo account is missing. `seed()` deletes and re-inserts
    // it wholesale, and several spec files share one Postgres — the same guard
    // `reminders.spec.ts` and `duplicate-guard.pg.spec.ts` document. File-level
    // sequencing (vitest.config.ts) is what makes the check itself safe.
    const existing = await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='alex-rivera'`);
    if (!existing) await seed(db);
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  it('books a free slot and rejects the double-booking (app-level + EXCLUDE)', async () => {
    const avail = await getAvailability(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      fromMs: Date.now(),
      toMs: Date.now() + 10 * 86_400_000,
    });
    const startMs = new Date(avail!.slots[0]!.startUtc).getTime();
    const args = {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      startMs,
      attendee: {
        name: 'Sam',
        email: 'sam@example.com',
        timeZone: 'America/New_York',
      },
      answers: { company: 'Acme' },
    };
    const first = await createBooking(db, args);
    expect(first.ok).toBe(true);
    const second = await createBooking(db, {
      ...args,
      attendee: {
        name: 'Pat',
        email: 'pat@example.com',
        timeZone: 'America/New_York',
      },
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('SLOT_TAKEN');
  });

  it('the booking_no_overlap EXCLUDE constraint physically blocks an overlap', async () => {
    // Bypass the app-level check entirely and insert two overlapping accepted
    // bookings for the same host directly — the DB constraint must reject the
    // second with a 23P01 exclusion_violation. This is the hard guarantee.
    const account = await getAccountByCode(db, 'acme');
    const member = await getMember(db, account!.id, 'alex-rivera');
    const start = Date.UTC(2030, 0, 1, 15, 0, 0); // far future, no clash
    const end = start + 30 * 60_000;
    const now = Date.now();

    const rawInsert = (id: string, uid: string, s: number, e: number) =>
      db.run(sql`INSERT INTO booking (id, account_id, uid, host_member_id, title, start_ms, end_ms,
        status, created_at, updated_at)
        VALUES (${id}, ${account!.id}, ${uid}, ${member!.id}, ${'Direct'}, ${s}, ${e},
        'accepted', ${now}, ${now})`);

    await rawInsert(randomUUID(), randomUUID(), start, end);

    let threw = false;
    try {
      // Overlaps [start, end) → must violate the EXCLUDE constraint.
      await rawInsert(randomUUID(), randomUUID(), start + 10 * 60_000, end + 10 * 60_000);
    } catch (err) {
      threw = true;
      expect(isExclusionViolation(err)).toBe(true);
    }
    expect(threw).toBe(true);
  });

  it('the EXCLUDE constraint also blocks two overlapping PENDING bookings (H1)', async () => {
    // 0001 widened the predicate to status IN ('accepted','pending'): a pending
    // requiresConfirmation booking holds the slot at the DB level too, so a
    // concurrent second pending for the same host/interval must be rejected.
    const account = await getAccountByCode(db, 'acme');
    const member = await getMember(db, account!.id, 'alex-rivera');
    const start = Date.UTC(2031, 5, 1, 15, 0, 0); // far future, distinct window
    const end = start + 30 * 60_000;
    const now = Date.now();

    const rawInsertPending = (id: string, uid: string, s: number, e: number) =>
      db.run(sql`INSERT INTO booking (id, account_id, uid, host_member_id, title, start_ms, end_ms,
        status, created_at, updated_at)
        VALUES (${id}, ${account!.id}, ${uid}, ${member!.id}, ${'Direct'}, ${s}, ${e},
        'pending', ${now}, ${now})`);

    await rawInsertPending(randomUUID(), randomUUID(), start, end);

    let threw = false;
    try {
      await rawInsertPending(randomUUID(), randomUUID(), start + 10 * 60_000, end + 10 * 60_000);
    } catch (err) {
      threw = true;
      expect(isExclusionViolation(err)).toBe(true);
    }
    expect(threw).toBe(true);
  });

  it('persists v2 replay, guests, and a linked new-UID reschedule on Postgres', async () => {
    const account = await getAccountByCode(db, 'acme');
    const availability = await getAvailability(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      fromMs: Date.now(),
      toMs: Date.now() + 20 * 86_400_000,
    });
    const starts = availability!.slots.map((slot) => new Date(slot.startUtc).getTime());
    const created = await createBooking(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      startMs: starts[0]!,
      attendee: {
        name: 'Pilot',
        email: 'pilot-pg@example.com',
        timeZone: 'UTC',
      },
      answers: { company: 'Dapta' },
      metadata: { source: 'pg-parity' },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(
      await addGuestsToBooking(db, {
        accountId: account!.id,
        uid: created.booking.uid,
        guests: [{ email: 'guest-pg@example.com', name: 'Guest' }, { email: 'GUEST-PG@example.com' }],
      }),
    ).toEqual({ ok: true, added: 1 });

    const moved = await rescheduleBookingV2(db, {
      accountId: account!.id,
      uid: created.booking.uid,
      newStartMs: starts[1]!,
      idempotencyKey: 'idem-key',
      reason: 'Postgres parity',
    });
    expect(moved).toMatchObject({ ok: true, uid: expect.any(String) });
    if (!moved.ok) return;
    expect(moved.uid).not.toBe(created.booking.uid);
    const links = await db.all<{
      uid: string;
      rescheduled_from_uid: string | null;
      rescheduled_to_uid: string | null;
    }>(
      sql`SELECT uid, rescheduled_from_uid, rescheduled_to_uid FROM booking
          WHERE uid IN (${created.booking.uid}, ${moved.uid}) ORDER BY uid`,
    );
    expect(links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          uid: created.booking.uid,
          rescheduled_to_uid: moved.uid,
        }),
        expect.objectContaining({
          uid: moved.uid,
          rescheduled_from_uid: created.booking.uid,
        }),
      ]),
    );
    const guestCount = await db.get<{ count: number }>(
      sql`SELECT COUNT(*) AS count FROM booking_guest bg
          JOIN booking b ON b.id = bg.booking_id WHERE b.uid = ${moved.uid}`,
    );
    expect(Number(guestCount?.count)).toBe(1);

    const claim = await claimApiIdempotency(db, {
      namespaceHash: `pg-${randomUUID()}`,
      accountId: account!.id,
      apiKeyId: 'pg-test-key',
      method: 'POST',
      path: '/v2/bookings/example/cancel',
      requestHash: 'request-a',
    });
    await completeApiIdempotency(db, claim.id, 200, { uid: moved.uid });
    const replay = await claimApiIdempotency(db, {
      namespaceHash: (await db.get<{ namespace_hash: string }>(
        sql`SELECT namespace_hash FROM api_idempotency WHERE id = ${claim.id}`,
      ))!.namespace_hash,
      accountId: account!.id,
      apiKeyId: 'pg-test-key',
      method: 'POST',
      path: '/v2/bookings/example/cancel',
      requestHash: 'request-a',
    });
    expect(replay).toMatchObject({
      statusCode: 200,
      responseBody: { uid: moved.uid },
    });
  });
});
