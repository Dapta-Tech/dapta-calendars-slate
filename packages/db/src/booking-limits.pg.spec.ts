import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import { seed } from './seed';
import { createBooking } from './repository';
import { createTeamBooking } from './parity';

// Booking limits under concurrency on real Postgres: the limit is counted again
// inside the locked write, so two people booking the last time of a day cannot
// both win. A team event's hosts take different member locks, so only the
// event-level lock serializes them. Two pools stand in for two API replicas.
// Skipped on the SQLite default.
const url = process.env.DATABASE_URL ?? '';
const isPg = url.startsWith('postgres://') || url.startsWith('postgresql://');
const describePg = isPg ? describe : describe.skip;

describePg('booking limits under concurrency (real Postgres)', () => {
  let a: Db;
  let b: Db;
  let accountId: string;
  const tag = randomUUID().slice(0, 8);
  const hosts = [randomUUID(), randomUUID()];
  const teamSlug = `limits-${tag}`;

  beforeAll(async () => {
    a = await createDb(url);
    b = await createDb(url);
    await migrate(a);
    if (!(await a.get(sql`SELECT id FROM member WHERE handle='alex-rivera'`))) await seed(a);
    accountId = (await a.get<{ id: string }>(sql`SELECT id FROM account WHERE code='acme'`))!.id;
    const teamId = randomUUID();
    const teamEvent = randomUUID();
    await a.run(sql`INSERT INTO team (id, account_id, name, slug, time_zone, hide_branding, created_at)
        VALUES (${teamId}, ${accountId}, 'Limits', ${teamSlug}, 'UTC', 0, 0)`);
    await a.run(sql`INSERT INTO event_type (id, account_id, team_id, slug, title, length_minutes, scheduling_type,
          minimum_booking_notice, slot_interval, max_bookings_per_day, created_at)
        VALUES (${teamEvent}, ${accountId}, ${teamId}, 'race', 'Race', 30, 'round_robin', 0, 30, 1, 0)`);
    for (const [i, id] of hosts.entries()) {
      const schedule = randomUUID();
      await a.run(sql`INSERT INTO member (id, account_id, handle, display_name, email, time_zone, default_schedule_id, created_at)
          VALUES (${id}, ${accountId}, ${`lim-${tag}-${i}`}, 'Host', ${`lim-${tag}-${i}@example.com`}, 'UTC', ${schedule}, 0)`);
      await a.run(sql`INSERT INTO schedule (id, account_id, member_id, name, time_zone, created_at)
          VALUES (${schedule}, ${accountId}, ${id}, 'All day', 'UTC', 0)`);
      await a.run(sql`INSERT INTO availability (id, schedule_id, days, start_time, end_time, date)
          VALUES (${randomUUID()}, ${schedule}, '[0,1,2,3,4,5,6]', '00:00', '23:30', NULL)`);
      await a.run(sql`INSERT INTO team_membership (id, account_id, team_id, member_id, role, accepted, created_at)
          VALUES (${randomUUID()}, ${accountId}, ${teamId}, ${id}, 'member', 1, 0)`);
      await a.run(sql`INSERT INTO event_type_host (id, account_id, event_type_id, member_id, is_fixed, priority, weight, schedule_id, created_at)
          VALUES (${randomUUID()}, ${accountId}, ${teamEvent}, ${id}, 0, NULL, 100, NULL, 0)`);
      await a.run(sql`INSERT INTO event_type (id, account_id, member_id, slug, title, length_minutes, schedule_id,
            minimum_booking_notice, slot_interval, max_bookings_per_day, created_at)
          VALUES (${randomUUID()}, ${accountId}, ${id}, 'race', 'Race', 30, ${schedule}, 0, 30, 1, 0)`);
    }
  });

  afterAll(async () => {
    await a?.close();
    await b?.close();
  });

  /** 10:00 and 14:00 UTC, `days` from today: two free times on one day. */
  const twoTimes = (days: number) => {
    const d = new Date(Date.now() + days * 86_400_000);
    const at = (h: number) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h);
    return [at(10), at(14)] as const;
  };
  const who = (n: string) => ({ name: 'Race', email: `${n}-${tag}@example.com`, timeZone: 'UTC' });

  it('a team event (one host each) and a personal event: exactly one of two bookings of the last time wins', async () => {
    for (let round = 0; round < 4; round++) {
      const [t1, t2] = twoTimes(20 + round);
      const team = await Promise.all([
        createTeamBooking(a, { accountCode: 'acme', teamSlug, slug: 'race', startMs: t1, attendee: who(`t1-${round}`) }),
        createTeamBooking(b, { accountCode: 'acme', teamSlug, slug: 'race', startMs: t2, attendee: who(`t2-${round}`) }),
      ]);
      expect(team.filter((r) => r.ok), `team round ${round}`).toHaveLength(1);
      const [p1, p2] = twoTimes(30 + round);
      const personal = await Promise.all([
        createBooking(a, { accountCode: 'acme', memberId: hosts[0], slug: 'race', startMs: p1, attendee: who(`p1-${round}`) }),
        createBooking(b, { accountCode: 'acme', memberId: hosts[0], slug: 'race', startMs: p2, attendee: who(`p2-${round}`) }),
      ]);
      expect(personal.filter((r) => r.ok), `personal round ${round}`).toHaveLength(1);
    }
  });
});
