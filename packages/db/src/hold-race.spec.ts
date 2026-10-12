import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import { seed } from './seed';
import { getAvailability } from './repository';
import { reserveSlot } from './parity';
import { createEventType } from './crud';

/**
 * Visitors racing for one time. A hold is checked against a snapshot of the
 * page's availability, and before the guarded insert every concurrent caller
 * saw the same snapshot: twenty visitors picking the same time all got a hold
 * (18 of 20 on Postgres, 20 of 20 on SQLite), and each loser learned only at
 * the final confirm. The same race let the per-page cap of ten be overrun.
 *
 * Runs on SQLite always and on Postgres when DATABASE_URL names one (the CI
 * Postgres job). Each run gets its own host so a hold left standing never hides
 * slots from another file sharing the database.
 */
const pgUrl = process.env.DATABASE_URL ?? '';
const engines: Array<[string, string]> = [['sqlite', 'file::memory:']];
if (pgUrl.startsWith('postgres://') || pgUrl.startsWith('postgresql://')) engines.push(['postgres', pgUrl]);

describe.each(engines)('reserveSlot under concurrency (%s)', (_name, url) => {
  let db: Db;
  const tag = randomUUID().slice(0, 8);
  const handle = `race-host-${tag}`;
  const slug = `race-event-${tag}`;

  beforeAll(async () => {
    db = await createDb(url);
    await migrate(db);
    const existing = await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='alex-rivera'`);
    if (!existing) await seed(db);
    const accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code='acme'`))!.id;
    const memberId = randomUUID();
    const scheduleId = randomUUID();
    const now = Date.now();
    await db.run(
      sql`INSERT INTO member (id, account_id, handle, display_name, email, time_zone, default_schedule_id, created_at)
          VALUES (${memberId}, ${accountId}, ${handle}, ${'Race Host'}, ${`${handle}@example.com`}, ${'UTC'}, ${scheduleId}, ${now})`,
    );
    await db.run(
      sql`INSERT INTO schedule (id, account_id, member_id, name, time_zone, created_at)
          VALUES (${scheduleId}, ${accountId}, ${memberId}, ${'Always'}, ${'UTC'}, ${now})`,
    );
    // Every day, all day: the race is about the hold, not the schedule.
    await db.run(
      sql`INSERT INTO availability (id, schedule_id, days, start_time, end_time, date)
          VALUES (${randomUUID()}, ${scheduleId}, ${JSON.stringify([0, 1, 2, 3, 4, 5, 6])}, ${'00:00'}, ${'23:59'}, ${null})`,
    );
    const ev = await createEventType(db, accountId, memberId, { slug, title: 'Race', lengthMinutes: 30, scheduleId });
    if (!ev.ok) throw new Error(`setup: event create failed (${ev.reason})`);
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  async function offered(dayOffset: number): Promise<number[]> {
    const fromMs = Date.now() + dayOffset * 86_400_000;
    const a = await getAvailability(db, { accountCode: 'acme', handle, slug, fromMs, toMs: fromMs + 86_400_000 });
    return (a?.slots ?? []).map((s) => new Date(s.startUtc).getTime());
  }

  const hold = (startMs: number) => reserveSlot(db, { accountCode: 'acme', handle, slug, startMs });

  it('twenty visitors on one time: exactly one hold, the rest INVALID_SLOT', async () => {
    const [start] = await offered(2);
    const out = await Promise.all(Array.from({ length: 20 }, () => hold(start!)));
    expect(out.filter((o) => o.ok)).toHaveLength(1);
    expect(out.filter((o) => !o.ok).every((o) => !o.ok && o.reason === 'INVALID_SLOT')).toBe(true);
    // And the time is gone from the page for everyone else.
    expect(await offered(2)).not.toContain(start);
  });

  it('two pairs racing for two neighbouring times: one hold each', async () => {
    // The guard refuses overlap, not proximity: adjacent times both stay holdable.
    const [a, b] = await offered(4);
    const out = await Promise.all([hold(a!), hold(a!), hold(b!), hold(b!)]);
    expect(out.filter((o) => o.ok)).toHaveLength(2);
  });

  it('twenty visitors on twenty times: the cap of ten holds, not twenty', async () => {
    const times = (await offered(6)).slice(0, 20);
    expect(times).toHaveLength(20);
    const out = await Promise.all(times.map(hold));
    expect(out.some((o) => !o.ok && o.reason === 'RATE_LIMITED')).toBe(true);
    // Counting every hold this host has, the three above included.
    const active = await db.get<{ n: number | string }>(
      sql`SELECT COUNT(*) AS n FROM slot_reservation s JOIN member m ON m.id = s.member_id
          WHERE m.handle = ${handle} AND s.release_at_ms > ${Date.now()}`,
    );
    expect(Number(active?.n)).toBe(10);
  });
});

/**
 * A hold lasts ten minutes and then lets go on its own: the time is offered
 * again and a second visitor can hold it. Only `Date` is faked; the database
 * runs for real.
 */
describe('a hold expires after ten minutes', () => {
  let db: Db;

  beforeAll(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
  });
  afterAll(async () => {
    vi.useRealTimers();
    if (db) await db.close();
  });

  it('is offered again at 10:01, and not at 9:59', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.now();
    const page = { accountCode: 'acme', handle: 'alex-rivera', slug: 'intro-call' };
    const read = async () => {
      const a = await getAvailability(db, { ...page, fromMs: t0, toMs: t0 + 10 * 86_400_000 });
      return (a?.slots ?? []).map((s) => new Date(s.startUtc).getTime());
    };
    const [start] = await read();
    const first = await reserveSlot(db, { ...page, startMs: start! });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.releaseAtMs - t0).toBe(10 * 60_000);
    expect(await read()).not.toContain(start);

    vi.setSystemTime(t0 + 9 * 60_000 + 59_000);
    expect(await read()).not.toContain(start);
    expect(await reserveSlot(db, { ...page, startMs: start! })).toEqual({ ok: false, reason: 'INVALID_SLOT' });

    vi.setSystemTime(t0 + 10 * 60_000 + 1_000);
    expect(await read()).toContain(start);
    const second = await reserveSlot(db, { ...page, startMs: start! });
    expect(second.ok).toBe(true);
    vi.useRealTimers();
  });
});
