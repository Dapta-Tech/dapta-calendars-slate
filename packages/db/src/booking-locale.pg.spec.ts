import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import { seed } from './seed';
import { createBooking, getAccountByCode, getAvailability } from './repository';
import { createTeamBooking, getTeamAvailability, loadBookingNotificationContext } from './parity';
import { addGuestsToBooking, rescheduleBookingV2 } from './v2-pilot';

/**
 * `booking.locale` and the notification context on real Postgres: the column
 * on all three booking inserts, the v2 reschedule's copy, the jsonb read of the
 * event type's questions and the guests query (a UNION over two tables). The
 * SQLite twin is `booking-locale.spec.ts`. Skipped on the SQLite dev default.
 */
const url = process.env.DATABASE_URL ?? '';
const isPg = url.startsWith('postgres://') || url.startsWith('postgresql://');
const describePg = isPg ? describe : describe.skip;

describePg('booking.locale and the notification context (real Postgres)', () => {
  let db: Db;
  let accountId: string;
  // One tag per run, so the file runs again on the database it ran on.
  const run = randomUUID().slice(0, 8);

  beforeAll(async () => {
    db = await createDb(url);
    await migrate(db);
    // Seed only if the demo account is missing (see repository.pg.spec.ts).
    const existing = await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='alex-rivera'`);
    if (!existing) await seed(db);
    accountId = (await getAccountByCode(db, 'acme'))!.id;
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  async function slots(): Promise<number[]> {
    const a = await getAvailability(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      fromMs: Date.now(),
      toMs: Date.now() + 20 * 86_400_000,
    });
    return a!.slots.map((s) => new Date(s.startUtc).getTime());
  }

  const stored = async (uid: string) =>
    (await db.get<{ locale: string | null }>(sql`SELECT locale FROM booking WHERE uid = ${uid}`))!.locale;

  it('stores the language, and the context reads it back with the people and the questions', async () => {
    const [start, later] = await slots();
    const created = await createBooking(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      startMs: start!,
      attendee: {
        name: 'Sam',
        email: `sam-${run}@example.com`,
        timeZone: 'America/Phoenix',
        phone: '+1 602 555 0143',
        notes: 'Joining from my phone',
      },
      additionalAttendees: [{ name: 'Ana Ruiz', email: `ana-${run}@example.com`, timeZone: 'UTC' }],
      answers: { company: 'Example Co' },
      locale: 'es-MX',
    });
    if (!created.ok) throw new Error(`book failed: ${created.reason}`);
    const uid = created.booking.uid;
    expect(await stored(uid)).toBe('es');
    await addGuestsToBooking(db, { accountId, uid, guests: [{ email: `bo-${run}@example.com` }] });

    const ctx = (await loadBookingNotificationContext(db, uid))!;
    expect(ctx.attendeeLocale).toBe('es');
    expect(ctx.attendee).toMatchObject({ phone: '+1 602 555 0143', notes: 'Joining from my phone' });
    expect(ctx.guests.map((g) => g.email).sort()).toEqual([`ana-${run}@example.com`, `bo-${run}@example.com`]);
    expect(ctx.bookingFields.map((f) => f.label)).toEqual(['Company', 'What would you like to discuss?']);

    const moved = await rescheduleBookingV2(db, { accountId, uid, newStartMs: later! });
    if (!moved.ok) throw new Error(`reschedule failed: ${moved.reason}`);
    expect(await stored(moved.uid)).toBe('es');
  });

  it('the team path stores it, and a booking naming none stores NULL', async () => {
    const team = await getTeamAvailability(db, {
      accountCode: 'acme',
      teamSlug: 'sales',
      slug: 'team-demo',
      fromMs: Date.now(),
      toMs: Date.now() + 20 * 86_400_000,
    });
    const out = await createTeamBooking(db, {
      accountCode: 'acme',
      teamSlug: 'sales',
      slug: 'team-demo',
      startMs: new Date(team!.slots[0]!).getTime(),
      attendee: { name: 'Sam', email: `team-${run}@example.com`, timeZone: 'UTC' },
      locale: 'en',
    });
    if (!out.ok) throw new Error(`team book failed: ${out.reason}`);
    expect(await stored(out.uid)).toBe('en');

    const [start] = await slots();
    const plain = await createBooking(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      startMs: start!,
      attendee: { name: 'Pat', email: `pat-${run}@example.com`, timeZone: 'UTC' },
      answers: { company: 'Example Co' },
    });
    if (!plain.ok) throw new Error(`book failed: ${plain.reason}`);
    expect(await stored(plain.booking.uid)).toBeNull();
    expect((await loadBookingNotificationContext(db, plain.booking.uid))!.attendeeLocale).toBeNull();
  });
});
