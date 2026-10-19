import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createDb, type Db } from './client';
import { migrate } from './migrate';
import { seed } from './seed';
import { createBooking, getAvailability } from './repository';
import { confirmBooking } from './parity';

/**
 * A host is busy for a booking whether they organize it or sit on it as an
 * assigned co-host (`booking_host`). The Postgres EXCLUDE sees organizers only,
 * so for a co-host the app-level guard is the whole guard: a personal booking
 * must not land on a time its host already holds as a co-host, and a request
 * must not be confirmed over one. (The racing versions run on real Postgres in
 * `cohost-guard.pg.spec.ts`.)
 */
describe('a co-host seat is a booking like any other (SQLite)', () => {
  let db: Db;
  let accountId: string;
  let alex: string;
  let jordan: string;

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code='acme'`))!.id;
    alex = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='alex-rivera'`))!.id;
    jordan = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='jordan-lee'`))!.id;
  });

  async function firstSlot(): Promise<number> {
    const a = await getAvailability(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      fromMs: Date.now(),
      toMs: Date.now() + 14 * 86_400_000,
    });
    return Date.parse(a!.slots[0]!.startUtc);
  }

  /** A team booking organized by Jordan with Alex as a co-host, over [start, start+30m). */
  async function alexAsCoHost(startMs: number, status = 'accepted'): Promise<string> {
    const id = randomUUID();
    await db.run(
      sql`INSERT INTO booking (id, account_id, uid, host_member_id, title, start_ms, end_ms, status, created_at, updated_at)
          VALUES (${id}, ${accountId}, ${randomUUID()}, ${jordan}, 'Team', ${startMs}, ${startMs + 30 * 60_000},
            ${status}, 0, 0)`,
    );
    await db.run(
      sql`INSERT INTO booking_host (id, booking_id, member_id, is_fixed, created_at)
          VALUES (${randomUUID()}, ${id}, ${alex}, 1, 0)`,
    );
    return id;
  }

  it('a personal booking cannot land on a time its host holds as a co-host', async () => {
    const startMs = await firstSlot();
    await alexAsCoHost(startMs);
    const r = await createBooking(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      startMs,
      attendee: { name: 'Sam', email: 'sam-cohost@example.com', timeZone: 'UTC' },
      answers: { company: 'Acme' },
      onBehalf: true,
    });
    expect(r).toMatchObject({ ok: false, reason: 'SLOT_TAKEN' });
  });

  it("a request is not confirmed over its host's co-host seat", async () => {
    await db.run(sql`UPDATE event_type SET requires_confirmation = 1 WHERE slug = 'intro-call'`);
    const startMs = await firstSlot();
    const req = await createBooking(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      startMs,
      attendee: { name: 'Sam', email: 'sam-req@example.com', timeZone: 'UTC' },
      answers: { company: 'Acme' },
    });
    if (!req.ok) throw new Error('request failed');
    await alexAsCoHost(startMs);
    expect(await confirmBooking(db, req.booking.uid, accountId)).toMatchObject({ ok: false, reason: 'SLOT_TAKEN' });
  });
});
