import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import { seed } from './seed';
import { getAvailability } from './repository';
import { releaseSlot, reserveSlot } from './parity';
import { createEventType } from './crud';

// Postgres is the source of truth (invariant 1), so the release path (#135) is
// proven on it as well as on the SQLite dev accelerator. What this file adds
// over `slot-release.spec.ts` is dialect coverage: `slot_reservation` holds
// `release_at_ms` as a Postgres `bigint` and a SQLite `integer`, and the delete
// and the busy-window read must mean the same thing on both. Skipped on the
// SQLite default.
const url = process.env.DATABASE_URL ?? '';
const isPg = url.startsWith('postgres://') || url.startsWith('postgresql://');
const describePg = isPg ? describe : describe.skip;

describePg('releaseSlot (real Postgres, #135)', () => {
  let db: Db;
  // Unique per run: this database is not recreated between runs, and several
  // spec files share it. A hold is scoped to its MEMBER, so this file gets its
  // own member rather than holding slots on the seeded demo host — a hold left
  // standing on `alex-rivera` would hide slots from whatever file reads that
  // page next.
  const tag = randomUUID().slice(0, 8);
  const handle = `release-host-${tag}`;
  const slug = `release-event-${tag}`;

  beforeAll(async () => {
    db = await createDb(url);
    await migrate(db);
    // Seed ONLY if the demo account is missing — `seed()` deletes and re-inserts
    // it wholesale, and re-seeding unconditionally wipes the account another
    // file is mid-test on. Same guard `duplicate-guard.pg.spec.ts` documents.
    const existing = await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='alex-rivera'`);
    if (!existing) await seed(db);
    const accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code='acme'`))!.id;

    const memberId = randomUUID();
    const scheduleId = randomUUID();
    const now = Date.now();
    await db.run(
      sql`INSERT INTO member (id, account_id, handle, display_name, email, time_zone, default_schedule_id, created_at)
          VALUES (${memberId}, ${accountId}, ${handle}, ${'Release Host'},
            ${`${handle}@example.com`}, ${'America/New_York'}, ${scheduleId}, ${now})`,
    );
    await db.run(
      sql`INSERT INTO schedule (id, account_id, member_id, name, time_zone, created_at)
          VALUES (${scheduleId}, ${accountId}, ${memberId}, ${'Working Hours'}, ${'America/New_York'}, ${now})`,
    );
    // Mon–Fri 09:00–17:00, as the seeded hosts have.
    await db.run(
      sql`INSERT INTO availability (id, schedule_id, days, start_time, end_time, date)
          VALUES (${randomUUID()}, ${scheduleId}, ${JSON.stringify([1, 2, 3, 4, 5])}, ${'09:00'}, ${'17:00'}, ${null})`,
    );
    const ev = await createEventType(db, accountId, memberId, {
      slug,
      title: 'Release event',
      lengthMinutes: 30,
      scheduleId,
    });
    if (!ev.ok) throw new Error(`setup: event create failed (${ev.reason})`);
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  async function slots(): Promise<string[]> {
    const a = await getAvailability(db, {
      accountCode: 'acme',
      handle,
      slug,
      fromMs: Date.now(),
      toMs: Date.now() + 10 * 86_400_000,
    });
    return (a?.slots ?? []).map((s) => s.startUtc);
  }

  async function hold(startMs: number) {
    const held = await reserveSlot(db, { accountCode: 'acme', handle, slug, startMs });
    if (!held.ok) throw new Error(`setup: reserve failed (${held.reason})`);
    return held;
  }

  it('a released hold puts the slot back', async () => {
    const startUtc = (await slots())[0]!;
    const held = await hold(new Date(startUtc).getTime());
    expect(await slots()).not.toContain(startUtc);

    await releaseSlot(db, held.uid);

    expect(await slots()).toContain(startUtc);
    const row = await db.get<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM slot_reservation WHERE uid = ${held.uid}`,
    );
    expect(Number(row?.n ?? 0)).toBe(0);
  });

  it('releasing a hold that is not yours changes nothing and raises nothing', async () => {
    const startUtc = (await slots())[0]!;
    const held = await hold(new Date(startUtc).getTime());

    await expect(releaseSlot(db, randomUUID())).resolves.toBeUndefined();
    await expect(releaseSlot(db, 'not-a-uid')).resolves.toBeUndefined();

    expect(await slots()).not.toContain(startUtc);
    // Leave nothing behind for the next file sharing this database.
    await releaseSlot(db, held.uid);
  });

  it('releasing an already-expired hold is a no-op', async () => {
    const startUtc = (await slots())[0]!;
    const held = await hold(new Date(startUtc).getTime());
    // `release_at_ms` is a Postgres bigint — expiring it in place also proves
    // the comparison the busy-window read makes against it.
    await db.run(
      sql`UPDATE slot_reservation SET release_at_ms = ${Date.now() - 1_000} WHERE uid = ${held.uid}`,
    );

    await expect(releaseSlot(db, held.uid)).resolves.toBeUndefined();
    expect(await slots()).toContain(startUtc);
  });
});
