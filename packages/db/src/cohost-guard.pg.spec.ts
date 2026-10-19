import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import { seed } from './seed';
import { createBooking } from './repository';
import { confirmBooking } from './parity';

// The racing half of `cohost-guard.spec.ts`, on real Postgres: under READ
// COMMITTED two guarded writes that give one member a booking could both pass
// their overlap checks before either committed, and the EXCLUDE only sees the
// organizer, so a co-host seat had no other guard. Every guarded write now
// locks the members it involves first. Two connection pools stand in for two
// API replicas. Skipped on the SQLite default.
const url = process.env.DATABASE_URL ?? '';
const isPg = url.startsWith('postgres://') || url.startsWith('postgresql://');
const describePg = isPg ? describe : describe.skip;

describePg('co-host seats under concurrency (real Postgres)', () => {
  let a: Db;
  let b: Db;
  let accountId: string;
  // This run's own hosts: the database is shared with other spec files.
  const tag = randomUUID().slice(0, 8);
  let organizer: string;
  let coHost: string;
  const eventSlug = `cohost-${tag}`;

  beforeAll(async () => {
    a = await createDb(url);
    b = await createDb(url);
    await migrate(a);
    const existing = await a.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='alex-rivera'`);
    if (!existing) await seed(a);
    accountId = (await a.get<{ id: string }>(sql`SELECT id FROM account WHERE code='acme'`))!.id;
    organizer = randomUUID();
    coHost = randomUUID();
    for (const [id, handle] of [
      [organizer, `org-${tag}`],
      [coHost, `co-${tag}`],
    ] as const) {
      await a.run(
        sql`INSERT INTO member (id, account_id, handle, display_name, email, time_zone, created_at)
            VALUES (${id}, ${accountId}, ${handle}, ${handle}, ${`${handle}@example.com`}, 'UTC', 0)`,
      );
    }
    // A personal event of the co-host's, needing confirmation, with no hours
    // rules in the way (on-behalf writes may book outside availability).
    await a.run(
      sql`INSERT INTO event_type (id, account_id, member_id, slug, title, length_minutes, requires_confirmation, created_at)
          VALUES (${randomUUID()}, ${accountId}, ${coHost}, ${eventSlug}, 'Co-host event', 30, 1, 0)`,
    );
  });

  afterAll(async () => {
    await a.close();
    await b.close();
  });

  const startAt = (offsetDays: number) => Date.now() + offsetDays * 86_400_000;

  async function insertBooking(db: Db, hostId: string, startMs: number, status: string, coHostId?: string) {
    const id = randomUUID();
    const uid = randomUUID();
    await db.run(
      sql`INSERT INTO booking (id, account_id, uid, host_member_id, title, start_ms, end_ms, status, metadata, created_at, updated_at)
          VALUES (${id}, ${accountId}, ${uid}, ${hostId}, 'Race', ${startMs}, ${startMs + 30 * 60_000}, ${status},
            ${'{}'}::jsonb, 0, 0)`,
    );
    if (coHostId)
      await db.run(
        sql`INSERT INTO booking_host (id, booking_id, member_id, is_fixed, created_at)
            VALUES (${randomUUID()}, ${id}, ${coHostId}, 1, 0)`,
      );
    return uid;
  }

  it('two requests over one member (one as organizer, one as co-host) confirmed at once: exactly one wins', async () => {
    for (let round = 0; round < 5; round++) {
      const startMs = startAt(30 + round);
      const own = await insertBooking(a, coHost, startMs, 'pending');
      const seat = await insertBooking(a, organizer, startMs, 'pending', coHost);
      const [r1, r2] = await Promise.all([confirmBooking(a, own, accountId), confirmBooking(b, seat, accountId)]);
      expect([r1.ok, r2.ok].filter(Boolean)).toHaveLength(1);
    }
  });

  it("a personal booking racing a confirmation of the host's co-host seat: never both", async () => {
    for (let round = 0; round < 5; round++) {
      const startMs = startAt(40 + round);
      const seat = await insertBooking(a, organizer, startMs, 'pending', coHost);
      const [booked, confirmed] = await Promise.all([
        createBooking(b, {
          accountCode: 'acme',
          memberId: coHost,
          slug: eventSlug,
          startMs,
          attendee: { name: 'Race', email: `race-${tag}-${round}@example.com`, timeZone: 'UTC' },
          onBehalf: true,
        }),
        confirmBooking(a, seat, accountId),
      ]);
      // The personal booking sees the seat whether it is still a request or
      // already confirmed, so it is refused; the confirmation then goes ahead.
      expect(booked.ok && confirmed.ok).toBe(false);
    }
  });
});
