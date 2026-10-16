import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDb, type Db } from './client';
import { migrate } from './migrate';
import { seed } from './seed';
import { bookingLocale, createBooking, getAvailability } from './repository';
import { createTeamBooking, getTeamAvailability, loadBookingNotificationContext } from './parity';
import { addGuestsToBooking, rescheduleBookingV2 } from './v2-pilot';

/**
 * `booking.locale` (F6) and what the host's copy of a booking email reads from
 * the notification context: who else the booking invites, the invitee's phone
 * and notes, and the event type's questions to label the answers with.
 */
describe('booking.locale and the notification context', () => {
  let db: Db;
  let accountId: string;

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code='acme'`))!.id;
  });

  async function slots(): Promise<number[]> {
    const a = await getAvailability(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      fromMs: Date.now(),
      toMs: Date.now() + 14 * 86_400_000,
    });
    return a!.slots.map((s) => new Date(s.startUtc).getTime());
  }

  async function book(startMs: number, extra: Record<string, unknown> = {}) {
    const out = await createBooking(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'intro-call',
      startMs,
      attendee: { name: 'Sam', email: 'Sam@Example.com', timeZone: 'America/Phoenix' },
      answers: { company: 'Example Co' },
      ...extra,
    });
    if (!out.ok) throw new Error(`book failed: ${out.reason}`);
    return out.booking.uid;
  }

  const stored = async (uid: string) =>
    (await db.get<{ locale: string | null }>(sql`SELECT locale FROM booking WHERE uid = ${uid}`))!
      .locale;

  it('keeps only en and es, from a bare or a regional tag', () => {
    expect(bookingLocale('es')).toBe('es');
    expect(bookingLocale(' ES-mx ')).toBe('es');
    expect(bookingLocale('en_GB')).toBe('en');
    expect(bookingLocale('fr')).toBeNull();
    expect(bookingLocale('')).toBeNull();
    expect(bookingLocale(undefined)).toBeNull();
    expect(bookingLocale(42)).toBeNull();
  });

  it('stores the language a booking was made in, and NULL when none was named', async () => {
    const [a, b, c] = await slots();
    expect(await stored(await book(a!, { locale: 'es-MX' }))).toBe('es');
    expect(await stored(await book(b!, { locale: 'fr' }))).toBeNull();
    expect(await stored(await book(c!))).toBeNull();
  });

  it('the team path stores it too', async () => {
    const team = await getTeamAvailability(db, {
      accountCode: 'acme',
      teamSlug: 'sales',
      slug: 'team-demo',
      fromMs: Date.now(),
      toMs: Date.now() + 14 * 86_400_000,
    });
    const out = await createTeamBooking(db, {
      accountCode: 'acme',
      teamSlug: 'sales',
      slug: 'team-demo',
      startMs: new Date(team!.slots[0]!).getTime(),
      attendee: { name: 'Sam', email: 'sam@example.com', timeZone: 'UTC' },
      locale: 'es',
    });
    if (!out.ok) throw new Error(`team book failed: ${out.reason}`);
    expect(await stored(out.uid)).toBe('es');
  });

  it('the context carries the language, the phone and notes, the other guests and the questions', async () => {
    const [start] = await slots();
    const uid = await book(start!, {
      locale: 'es',
      attendee: {
        name: 'Sam',
        email: 'Sam@Example.com',
        timeZone: 'America/Phoenix',
        phone: ' +1 602 555 0143 ',
        notes: 'Joining from my phone',
      },
      additionalAttendees: [
        { name: 'Ana Ruiz', email: 'ana@example.com', timeZone: 'UTC' },
        // The invitee's own address again, in another case: not a guest.
        { name: 'Sam again', email: 'sam@example.com', timeZone: 'UTC' },
      ],
    });
    expect(
      await addGuestsToBooking(db, {
        accountId,
        uid,
        guests: [{ email: 'bo@example.com' }, { email: 'ANA@example.com', name: 'Ana twice' }],
      }),
    ).toMatchObject({ ok: true });

    const ctx = (await loadBookingNotificationContext(db, uid))!;
    // The invitee is the one who booked, never one of the extra attendees.
    expect(ctx.attendee.email).toBe('Sam@Example.com');
    expect(ctx.attendeeLocale).toBe('es');
    expect(ctx.attendee).toMatchObject({
      phone: '+1 602 555 0143',
      notes: 'Joining from my phone',
    });
    expect(ctx.guests).toEqual([
      { name: 'Ana Ruiz', email: 'ana@example.com' },
      { name: null, email: 'bo@example.com' },
    ]);
    // The event type's questions, in its order and words (the seed asks two).
    expect(ctx.bookingFields).toEqual([
      { name: 'company', label: 'Company', type: 'text' },
      { name: 'topic', label: 'What would you like to discuss?', type: 'textarea' },
    ]);
    expect(ctx.formAnswers).toEqual({ company: 'Example Co' });
  });

  it('a booking with nothing extra reads as empty, and an old row reads NULL', async () => {
    const [start] = await slots();
    const uid = await book(start!);
    const ctx = (await loadBookingNotificationContext(db, uid))!;
    expect(ctx.attendeeLocale).toBeNull();
    expect(ctx.attendee).toMatchObject({ phone: null, notes: null });
    expect(ctx.guests).toEqual([]);
  });

  it('a v2 reschedule carries the language to the new booking', async () => {
    const [a, b] = await slots();
    const uid = await book(a!, { locale: 'es' });
    const moved = await rescheduleBookingV2(db, { accountId, uid, newStartMs: b! });
    if (!moved.ok) throw new Error(`reschedule failed: ${moved.reason}`);
    expect(moved.uid).not.toBe(uid);
    expect(await stored(moved.uid)).toBe('es');
  });
});
