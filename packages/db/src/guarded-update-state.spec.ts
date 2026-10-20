import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { BusyInterval, CalendarProvider } from '@slate/calendar';
import { createDb, type Db } from './client';
import { migrate } from './migrate';
import { seed } from './seed';
import { createBooking, getAvailability } from './repository';
import { confirmBooking, declineBooking, rescheduleBooking } from './parity';

/**
 * A confirmation or a move reads the booking, checks the calendars and the
 * other bookings, and only then writes. If the booking was cancelled (or
 * declined, or moved by v2) in between, the write must match nothing and say
 * GONE: a success here would send "confirmed" or "moved" mail, a webhook and a
 * calendar write for a booking that is off. The calendar read is the window,
 * so a calendar that cancels the booking while it is being read stands in for
 * the concurrent cancel.
 */
describe('a guarded update answers GONE when the booking changed under it', () => {
  let db: Db;
  let accountId: string;

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code='acme'`))!.id;
    const alex = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='alex-rivera'`))!.id;
    await db.run(
      sql`INSERT INTO connected_calendar (id, account_id, member_id, provider, external_id, is_destination, check_conflicts, created_at)
          VALUES (${randomUUID()}, ${accountId}, ${alex}, 'generic', 'ref-alex', 0, 1, 0)`,
    );
  });

  /** A calendar that, while it is being read, cancels the booking `uid` (the concurrent cancel). */
  function cancellingCalendar(uid: () => string): CalendarProvider {
    return {
      enabled: true,
      listBusy: async (): Promise<BusyInterval[]> => {
        await db.run(sql`UPDATE booking SET status = 'cancelled' WHERE uid = ${uid()}`);
        return [];
      },
      createEvent: async () => ({ externalEventId: 'e' }),
      updateEvent: async () => ({ externalEventId: 'e' }),
      deleteEvent: async () => undefined,
      listCalendars: async () => [],
      checkConnection: async () => ({ ok: true, detail: 'ok' }),
    };
  }

  async function slots(): Promise<number[]> {
    const a = await getAvailability(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      fromMs: Date.now(),
      toMs: Date.now() + 14 * 86_400_000,
    });
    return a!.slots.map((s) => Date.parse(s.startUtc));
  }

  async function book(startMs: number, tag: string): Promise<{ uid: string; token: string }> {
    const r = await createBooking(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      startMs,
      attendee: { name: 'Sam', email: `sam-${tag}@example.com`, timeZone: 'UTC' },
      answers: { company: 'Acme' },
    });
    if (!r.ok) throw new Error('booking failed');
    return { uid: r.booking.uid, token: r.manageToken };
  }

  it('a confirmation of a request cancelled meanwhile confirms nothing and says GONE', async () => {
    await db.run(sql`UPDATE event_type SET requires_confirmation = 1 WHERE slug = 'intro-call'`);
    const [first] = await slots();
    const { uid } = await book(first!, 'confirm');
    const out = await confirmBooking(db, uid, accountId, cancellingCalendar(() => uid));
    expect(out).toMatchObject({ ok: false, reason: 'GONE' });
    expect((await db.get<{ status: string }>(sql`SELECT status FROM booking WHERE uid = ${uid}`))!.status).toBe(
      'cancelled',
    );
  });

  it('a move of a booking cancelled meanwhile moves nothing and says GONE', async () => {
    const [first, second] = await slots();
    const { uid, token } = await book(first!, 'move');
    const out = await rescheduleBooking(
      db,
      { uid, newStartMs: second!, manageToken: token },
      cancellingCalendar(() => uid),
    );
    expect(out).toMatchObject({ ok: false, reason: 'GONE' });
    const row = (await db.get<{ status: string; start_ms: number }>(
      sql`SELECT status, start_ms FROM booking WHERE uid = ${uid}`,
    ))!;
    expect(row.status).toBe('cancelled');
    expect(Number(row.start_ms)).toBe(first);
  });

  it('a decline of a request confirmed meanwhile declines nothing and says GONE', async () => {
    await db.run(sql`UPDATE event_type SET requires_confirmation = 1 WHERE slug = 'intro-call'`);
    const [first] = await slots();
    const { uid } = await book(first!, 'decline');
    // The host confirms in another tab (or an agent does) right after the
    // decline read the request as pending, before the decline writes.
    let reads = 0;
    const racing = Object.create(db) as Db;
    racing.get = (async (query: Parameters<Db['get']>[0]) => {
      reads += 1;
      if (reads === 2) await db.run(sql`UPDATE booking SET status = 'accepted' WHERE uid = ${uid}`);
      return db.get(query);
    }) as Db['get'];
    expect(await declineBooking(racing, uid, 'no room', accountId)).toEqual({ ok: false, reason: 'GONE' });
    expect((await db.get<{ status: string }>(sql`SELECT status FROM booking WHERE uid = ${uid}`))!.status).toBe('accepted');
    expect(await declineBooking(db, uid, 'no room', accountId)).toEqual({ ok: false, reason: 'GONE' });
  });

  it('a second confirmation of one request says GONE instead of confirming it twice', async () => {
    await db.run(sql`UPDATE event_type SET requires_confirmation = 1 WHERE slug = 'intro-call'`);
    const [first] = await slots();
    const { uid } = await book(first!, 'twice');
    expect(await confirmBooking(db, uid, accountId)).toMatchObject({ ok: true });
    expect(await confirmBooking(db, uid, accountId)).toMatchObject({ ok: false, reason: 'GONE' });
  });
});
