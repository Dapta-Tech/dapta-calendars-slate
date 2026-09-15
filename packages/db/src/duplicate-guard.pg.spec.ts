import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import { seed } from './seed';
import { createBooking, getAvailability } from './repository';
import { createTeamBooking, getTeamAvailability } from './parity';
import { createEventType, createTeam } from './crud';

// Postgres is the source of truth (invariant 1), so the duplicate-booking guard
// (#69 / AB1) is proven on it as well as on the SQLite dev accelerator. What
// this file adds over `duplicate-guard.spec.ts` is dialect coverage: the two
// migrations must produce a schema the same code reads, and `lower(trim(...))`
// must mean the same thing on both engines. Skipped on the SQLite default.
const url = process.env.DATABASE_URL ?? '';
const isPg = url.startsWith('postgres://') || url.startsWith('postgresql://');
const describePg = isPg ? describe : describe.skip;

describePg('duplicate-booking guard (real Postgres)', () => {
  let db: Db;
  let accountId: string;
  let alexId: string;
  let jordanId: string;
  // Unique per run: this database is not recreated between runs, so fixed slugs
  // would collide with the rows a previous run left behind.
  const tag = randomUUID().slice(0, 8);

  beforeAll(async () => {
    db = await createDb(url);
    await migrate(db);
    // Seed ONLY if the demo account is missing. `seed()` deletes and re-inserts
    // it wholesale, and several spec files share one Postgres — re-seeding
    // unconditionally wipes the account another file is mid-test on. Same
    // guard `reminders.spec.ts` documents.
    const existing = await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='alex-rivera'`);
    if (!existing) await seed(db);
    accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code='acme'`))!.id;
    alexId = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='alex-rivera'`))!.id;
    jordanId = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='jordan-lee'`))!.id;
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  const attendee = (email: string) => ({ name: 'Pat', email, timeZone: 'America/New_York' });

  async function personalSlots(slug: string): Promise<number[]> {
    const r = await getAvailability(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug,
      fromMs: Date.now(),
      toMs: Date.now() + 10 * 86_400_000,
    });
    return (r?.slots ?? []).map((s) => new Date(s.startUtc).getTime());
  }

  it('blocks a second upcoming booking from the same email — personal path', async () => {
    const slug = `pg-dup-${tag}`;
    const ev = await createEventType(db, accountId, alexId, {
      slug,
      title: slug,
      lengthMinutes: 30,
      scheduleId: null,
      preventDuplicateBookings: true,
    });
    expect(ev.ok).toBe(true);

    const slots = await personalSlots(slug);
    const first = await createBooking(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug,
      startMs: slots[0]!,
      attendee: attendee('pat@example.com'),
    });
    expect(first.ok).toBe(true);

    // Same mailbox, different casing and padding — the normalizer must behave
    // identically to SQLite's.
    const second = await createBooking(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug,
      startMs: slots[1]!,
      attendee: attendee('  PAT@Example.com '),
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('DUPLICATE_BOOKING');

    // The stored normalized column is the jsonb/bigint-free half of the dual
    // schema: assert Postgres wrote what the guard reads.
    if (first.ok) {
      const row = await db.get<{ email_normalized: string | null }>(
        sql`SELECT a.email_normalized FROM booking_attendee a
            JOIN booking b ON b.id = a.booking_id WHERE b.uid = ${first.booking.uid}`,
      );
      expect(row?.email_normalized).toBe('pat@example.com');
    }
  });

  it('blocks a second upcoming booking from the same email — TEAM path', async () => {
    const slug = `pg-dup-team-${tag}`;
    const teamSlug = `${slug}-t`;
    const team = await createTeam(db, accountId, { name: slug, slug: teamSlug });
    expect(team.ok).toBe(true);
    if (!team.ok) return;
    const ev = await createEventType(db, accountId, null, {
      slug,
      title: slug,
      lengthMinutes: 30,
      schedulingType: 'round_robin',
      scheduleId: null,
      teamId: team.value.id,
      preventDuplicateBookings: true,
    });
    expect(ev.ok).toBe(true);
    if (!ev.ok) return;
    const now = Date.now();
    for (const memberId of [alexId, jordanId]) {
      await db.run(
        sql`INSERT INTO event_type_host (id, account_id, event_type_id, member_id, is_fixed, priority, weight, schedule_id, created_at)
            VALUES (${randomUUID()}, ${accountId}, ${ev.value.id}, ${memberId}, 0, NULL, 100, NULL, ${now})`,
      );
    }

    const avail = await getTeamAvailability(db, {
      accountCode: 'acme',
      teamSlug,
      slug,
      fromMs: Date.now(),
      toMs: Date.now() + 10 * 86_400_000,
    });
    const slots = (avail?.slots ?? []).map((s) => new Date(s).getTime());

    const first = await createTeamBooking(db, {
      accountCode: 'acme',
      teamSlug,
      slug,
      startMs: slots[0]!,
      attendee: attendee('team-pat@example.com'),
    });
    expect(first.ok).toBe(true);

    const second = await createTeamBooking(db, {
      accountCode: 'acme',
      teamSlug,
      slug,
      startMs: slots[1]!,
      attendee: attendee('team-pat@example.com'),
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('DUPLICATE_BOOKING');

    // An API-key write stays exempt on Postgres too.
    const viaKey = await createTeamBooking(db, {
      accountCode: 'acme',
      teamSlug,
      slug,
      startMs: slots[1]!,
      attendee: attendee('team-pat@example.com'),
      apiKeyWrite: true,
    });
    expect(viaKey.ok).toBe(true);
  });

  it('ships the column with DEFAULT 0, so existing event types read as off', async () => {
    const row = await db.get<{ prevent_duplicate_bookings: number }>(
      sql`SELECT prevent_duplicate_bookings FROM event_type WHERE slug = 'intro-call' LIMIT 1`,
    );
    expect(Number(row?.prevent_duplicate_bookings)).toBe(0);
  });
});
