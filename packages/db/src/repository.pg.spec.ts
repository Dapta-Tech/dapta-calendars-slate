import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { isExclusionViolation } from '@slate/engine';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import { seed } from './seed';
import { createBooking, getAvailability, getAccountByCode } from './repository';
import { createHostEvent } from './host-event';
import { createHostEventSeries, extendHostEventSeries, loadSeriesOccurrences, moveHostEventSeries } from './host-event-series';
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
  /**
   * F8: one tag per run, so this file can run again on the database it ran on
   * (a local Postgres, a re-run job). The first run's rows stay where they
   * are; every fixture below is named, timed or hosted so they never meet.
   */
  const run = randomUUID().slice(0, 8);

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
        email: `sam-${run}@example.com`,
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
        email: `pat-${run}@example.com`,
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
    //
    // The host is this run's own (the constraint keys on `host_member_id`,
    // which carries no foreign key): on the seeded host, a second run met the
    // first run's row with its FIRST insert and failed before the guarantee
    // was ever asked.
    const account = await getAccountByCode(db, 'acme');
    const host = `pg-host-${run}`;
    const start = Date.UTC(2030, 0, 1, 15, 0, 0); // far future, no clash
    const end = start + 30 * 60_000;
    const now = Date.now();

    const rawInsert = (id: string, uid: string, s: number, e: number) =>
      db.run(sql`INSERT INTO booking (id, account_id, uid, host_member_id, title, start_ms, end_ms,
        status, created_at, updated_at)
        VALUES (${id}, ${account!.id}, ${uid}, ${host}, ${'Direct'}, ${s}, ${e},
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

  it('a repeating host event is held by the same guards on every date, written, extended or moved', async () => {
    const account = await getAccountByCode(db, 'acme');
    const host = randomUUID();
    const now = Date.now();
    await db.run(sql`INSERT INTO member (id, account_id, handle, display_name, email, time_zone, created_at)
      VALUES (${host}, ${account!.id}, ${`pg-series-${run}`}, ${'PG Series Host'}, ${`pg-series-${run}@example.com`}, ${'UTC'}, ${now})`);
    // A Wednesday 15:30 UTC, at least two weeks out.
    const d = new Date(now + 14 * 86_400_000);
    d.setUTCDate(d.getUTCDate() + ((3 - d.getUTCDay() + 7) % 7));
    const startDate = d.toISOString().slice(0, 10);
    const series = await createHostEventSeries(db, {
      accountId: account!.id,
      memberId: host,
      title: 'Weekly Phone',
      attendees: [],
      anchor: { startDate, startTime: '15:30', durationMinutes: 30, timeZone: 'UTC' },
      rule: { frequency: 'weekly', interval: 1, weekdays: ['wednesday'], count: null, untilDate: null },
      // Held by a calendar, as a series with no end must be.
      calendarQueued: true,
      calendarDestination: 'cal-ext-pg',
    });
    expect(series.ok).toBe(true);
    const { seriesId } = series as { seriesId: string };
    const rows = await loadSeriesOccurrences(db, seriesId);
    expect(rows.length).toBeGreaterThan(20);
    // Every written date is a booking the EXCLUDE covers: a raw overlap on one is refused by Postgres.
    const tenth = rows[9]!;
    let threw = false;
    try {
      await db.run(sql`INSERT INTO booking (id, account_id, uid, host_member_id, title, start_ms, end_ms, status, created_at, updated_at)
        VALUES (${randomUUID()}, ${account!.id}, ${randomUUID()}, ${host}, ${'Direct'}, ${tenth.startMs},
          ${tenth.endMs}, 'accepted', ${now}, ${now})`);
    } catch (err) {
      threw = true;
      expect(isExclusionViolation(err)).toBe(true);
    }
    expect(threw).toBe(true);
    // The extension runs on several replicas at once: each date is written once.
    const later = now + 40 * 86_400_000;
    const [a, b] = await Promise.all([extendHostEventSeries(db, seriesId, later), extendHostEventSeries(db, seriesId, later)]);
    expect((a?.added ?? 0) + (b?.added ?? 0)).toBeGreaterThan(0);
    const after = await loadSeriesOccurrences(db, seriesId);
    expect(new Set(after.map((r) => r.occurrenceStartMs)).size).toBe(after.length);
    // A move checks every new date under the lock: a booking on one refuses it, nothing changes.
    await db.run(sql`INSERT INTO booking (id, account_id, uid, host_member_id, title, start_ms, end_ms, status, created_at, updated_at)
      VALUES (${randomUUID()}, ${account!.id}, ${randomUUID()}, ${host}, ${'Taken'}, ${rows[2]!.startMs + 3_600_000},
        ${rows[2]!.startMs + 2 * 3_600_000}, 'accepted', ${now}, ${now})`);
    const moved = await moveHostEventSeries(db, {
      accountId: account!.id,
      uid: rows[0]!.uid,
      scope: 'series',
      newStartMs: rows[0]!.startMs + 3_600_000,
    });
    expect(moved).toMatchObject({ ok: false, reason: 'SLOT_TAKEN' });
    expect((await loadSeriesOccurrences(db, seriesId)).every((r) => r.status === 'accepted')).toBe(true);
  });

  it('a host event (no event type) is held by the same guards: app-level and EXCLUDE', async () => {
    // This run's own host, as above; a member row, because createHostEvent acts
    // only for an active member of the account.
    const account = await getAccountByCode(db, 'acme');
    const host = randomUUID();
    const now = Date.now();
    await db.run(sql`INSERT INTO member (id, account_id, handle, display_name, email, time_zone, created_at)
      VALUES (${host}, ${account!.id}, ${`pg-events-${run}`}, ${'PG Host'}, ${`pg-events-${run}@example.com`}, ${'UTC'}, ${now})`);
    const start = Math.ceil((now + 30 * 86_400_000) / 3_600_000) * 3_600_000;
    const event = (startMs: number, endMs: number) =>
      createHostEvent(db, { accountId: account!.id, memberId: host, title: 'Focus', startMs, endMs, attendees: [], timeZone: 'UTC' });

    const first = await event(start, start + 4 * 3_600_000);
    expect(first.ok).toBe(true);
    const row = await db.get<{ event_type_id: string | null }>(
      sql`SELECT event_type_id FROM booking WHERE uid = ${(first as { uid: string }).uid}`,
    );
    expect(row!.event_type_id).toBeNull();
    // The app-level check, under the host's lock.
    expect(await event(start + 3_600_000, start + 2 * 3_600_000)).toMatchObject({ ok: false, reason: 'SLOT_TAKEN' });
    // And the EXCLUDE behind it: a raw overlapping row with no event type is refused by Postgres itself.
    let threw = false;
    try {
      await db.run(sql`INSERT INTO booking (id, account_id, uid, host_member_id, title, start_ms, end_ms, status, created_at, updated_at)
        VALUES (${randomUUID()}, ${account!.id}, ${randomUUID()}, ${host}, ${'Direct'}, ${start + 3_600_000},
          ${start + 2 * 3_600_000}, 'accepted', ${now}, ${now})`);
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
    const host = `pg-host-pending-${run}`; // this run's own host, as above
    const start = Date.UTC(2031, 5, 1, 15, 0, 0); // far future, distinct window
    const end = start + 30 * 60_000;
    const now = Date.now();

    const rawInsertPending = (id: string, uid: string, s: number, e: number) =>
      db.run(sql`INSERT INTO booking (id, account_id, uid, host_member_id, title, start_ms, end_ms,
        status, created_at, updated_at)
        VALUES (${id}, ${account!.id}, ${uid}, ${host}, ${'Direct'}, ${s}, ${e},
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
        email: `pilot-pg-${run}@example.com`,
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
        guests: [{ email: `guest-pg-${run}@example.com`, name: 'Guest' }, { email: `GUEST-PG-${run}@example.com` }],
      }),
    ).toEqual({ ok: true, added: 1 });

    const moved = await rescheduleBookingV2(db, {
      accountId: account!.id,
      uid: created.booking.uid,
      newStartMs: starts[1]!,
      // Stored on the new row under a GLOBAL unique index, so a fixed key made
      // a second run's reschedule collide with the first run's booking.
      idempotencyKey: `idem-key-${run}`,
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
