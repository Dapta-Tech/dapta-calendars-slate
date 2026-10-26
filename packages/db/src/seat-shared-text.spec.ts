import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import { seed } from './seed';
import { createBooking, getAvailability } from './repository';
import { createTeamBooking, getTeamAvailability, insertHoldGuarded } from './parity';
import { addAttendeeToBooking, addGuestsToBooking } from './v2-pilot';
import { createEventType, deleteEventType, updateEventType } from './crud';
import { applyCalendarTemplates, applySharedFallback } from './calendar-text';

// Both renders are spied on, so a test can make one of them not land.
vi.mock('./calendar-text', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./calendar-text')>();
  return {
    ...mod,
    applyCalendarTemplates: vi.fn(mod.applyCalendarTemplates),
    applySharedFallback: vi.fn(mod.applySharedFallback),
  };
});

/**
 * Taking a seat on a group slot: the slot's text is the shared one, written
 * with the seat, before its calendar event is rewritten for the person joining
 * (`seatTaken`), and a repeated seat is a replay. Its own file, so the renders
 * can be made to fail.
 */
describe('a seat taken on a group slot', () => {
  let db: Db;
  let accountId: string;
  let alexId: string;

  beforeEach(async () => {
    vi.mocked(applyCalendarTemplates).mockClear();
    vi.mocked(applySharedFallback).mockClear();
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code='acme'`))!.id;
    alexId = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='alex-rivera'`))!.id;
  });

  /** A slot Alice booked while the event had no seats and a personal title; then seats on. */
  async function slotBookedBeforeSeats(): Promise<{ startMs: number; uid: string }> {
    const out = await createEventType(db, accountId, alexId, {
      slug: 'office',
      title: 'Office hours',
      lengthMinutes: 30,
      calendarTitleTemplate: 'Office hours - {{name}}',
      calendarDescriptionTemplate: 'Email {{email}}',
    });
    if (!out.ok) throw new Error('event type failed');
    const a = await getAvailability(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'office',
      fromMs: Date.now(),
      toMs: Date.now() + 14 * 86_400_000,
    });
    const startMs = new Date(a!.slots[0]!.startUtc).getTime();
    const alice = await book(startMs, 'Alice Secret', 'alice@example.com');
    if (!alice.ok) throw new Error('first booking failed');
    await updateEventType(db, accountId, out.value.id, {
      seatsPerTimeSlot: 5,
      calendarTitleTemplate: null,
      calendarDescriptionTemplate: null,
    });
    return { startMs, uid: alice.booking.uid };
  }

  const book = (startMs: number, name: string, email: string) =>
    createBooking(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'office',
      startMs,
      attendee: { name, email, timeZone: 'UTC' },
    });

  const stored = async (uid: string) =>
    (await db.get<{ title: string; calendar_description: string | null }>(
      sql`SELECT title, calendar_description FROM booking WHERE uid = ${uid}`,
    ))!;

  it('when the shared render does not land, the slot is reset to the event name before the event is rewritten', async () => {
    const { startMs, uid } = await slotBookedBeforeSeats();
    expect((await stored(uid)).title).toBe('Office hours - Alice Secret');
    vi.mocked(applyCalendarTemplates).mockResolvedValueOnce(null);
    const bob = await book(startMs, 'Bob Other', 'bob@example.com');
    expect(bob).toMatchObject({ ok: true, seatTaken: true, booking: { title: 'Office hours', calendarDescription: null } });
    expect(applySharedFallback).toHaveBeenCalledTimes(1);
    expect(await stored(uid)).toEqual({ title: 'Office hours', calendar_description: '' });
  });

  it('when even the reset fails, the event is still rewritten for the new seat-taker, with the text the seat wrote', async () => {
    const { startMs, uid } = await slotBookedBeforeSeats();
    vi.mocked(applyCalendarTemplates).mockResolvedValueOnce(null);
    vi.mocked(applySharedFallback).mockResolvedValueOnce(null);
    const bob = await book(startMs, 'Bob Other', 'bob@example.com');
    if (!bob.ok) throw new Error('seat failed');
    // Not rewriting would leave Bob off the event for good: a repeat is a replay.
    expect(bob.seatTaken).toBe(true);
    expect(bob.booking).toMatchObject({ title: 'Office hours', calendarDescription: null });
    // The seat itself wrote the safe text with it: no reader sees Bob beside Alice's own text.
    expect(await stored(uid)).toEqual({ title: 'Office hours', calendar_description: '' });
  });

  it('the reset never writes over a booking that moved meanwhile', async () => {
    const { startMs, uid } = await slotBookedBeforeSeats();
    const row = (await db.get<{ id: string; title: string }>(sql`SELECT id, title FROM booking WHERE uid = ${uid}`))!;
    // Seen at one time, but the booking is now somewhere else.
    expect(await applySharedFallback(db, { id: row.id, startMs: startMs + 1, endMs: startMs + 30 * 60_000 }, 'Office hours')).toBeNull();
    expect((await stored(uid)).title).toBe(row.title);
    expect(
      await applySharedFallback(db, { id: row.id, startMs, endMs: startMs + 30 * 60_000 }, 'Office hours'),
    ).toEqual({ title: 'Office hours' });
  });

  it('a repeated seat is a replay: no second row, no seat spent, no rewrite, nobody else text', async () => {
    const { startMs, uid } = await slotBookedBeforeSeats();
    const first = await book(startMs, 'Bob Other', 'bob@example.com');
    expect(first).toMatchObject({ ok: true, seatTaken: true });
    const again = await book(startMs, 'Bob Other', ' BOB@example.com ');
    expect(again).toMatchObject({ ok: true, deduplicated: true, manageToken: '' });
    if (!again.ok) throw new Error('replay failed');
    expect(again.seatTaken).toBeUndefined();
    // Someone typing the first booker's address learns nothing of her text.
    const posing = await book(startMs, 'Mallory', 'alice@example.com');
    expect(posing).toMatchObject({ ok: true, deduplicated: true, booking: { title: 'Office hours', calendarDescription: null } });
    const count = await db.get<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM booking_attendee WHERE booking_id = (SELECT id FROM booking WHERE uid = ${uid})`,
    );
    expect(Number(count!.n)).toBe(2);
  });

  it('a seat request with several attendees takes one seat per new address, and counts only those', async () => {
    const { startMs, uid } = await slotBookedBeforeSeats();
    await db.run(sql`UPDATE event_type SET seats_per_time_slot = 3 WHERE slug = 'office'`);
    const seat = (attendee: string, others: string[]) =>
      createBooking(db, {
        accountCode: 'acme',
        handle: 'alex-rivera',
        slug: 'office',
        startMs,
        attendee: { name: attendee, email: `${attendee}@example.com`, timeZone: 'UTC' },
        additionalAttendees: others.map((o) => ({ name: o, email: `${o}@example.com`, timeZone: 'UTC' })),
      });
    const emails = async () =>
      (
        await db.all<{ email: string }>(
          sql`SELECT email FROM booking_attendee WHERE booking_id = (SELECT id FROM booking WHERE uid = ${uid}) ORDER BY created_at`,
        )
      ).map((r) => r.email.toLowerCase());
    // Three new people do not fit beside Alice in three seats.
    expect(await seat('bob', ['carl', 'dana'])).toMatchObject({ ok: false, reason: 'SLOT_TAKEN' });
    // Alice already holds hers and Carl is named twice: two new seats, which fit.
    expect(await seat('bob', ['alice', 'carl', 'CARL'])).toMatchObject({ ok: true, seatTaken: true });
    expect(await emails()).toEqual(['alice@example.com', 'bob@example.com', 'carl@example.com']);
  });

  it("the slot's first booking counts and writes each address once too", async () => {
    const out = await createEventType(db, accountId, alexId, {
      slug: 'pair',
      title: 'Pair session',
      lengthMinutes: 30,
      seatsPerTimeSlot: 2,
    });
    if (!out.ok) throw new Error('event type failed');
    const a = await getAvailability(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'pair',
      fromMs: Date.now(),
      toMs: Date.now() + 14 * 86_400_000,
    });
    const first = await createBooking(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'pair',
      startMs: new Date(a!.slots[0]!.startUtc).getTime(),
      attendee: { name: 'Ana', email: 'ana@example.com', timeZone: 'UTC' },
      // Ana again, and Bob twice: two people, which fit in two seats.
      additionalAttendees: ['ANA', 'bob', 'Bob'].map((n) => ({ name: n, email: `${n}@example.com`, timeZone: 'UTC' })),
    });
    if (!first.ok) throw new Error(`first booking failed: ${'reason' in first ? first.reason : ''}`);
    const rows = await db.all<{ email: string }>(
      sql`SELECT email FROM booking_attendee WHERE booking_id = (SELECT id FROM booking WHERE uid = ${first.booking.uid}) ORDER BY created_at`,
    );
    expect(rows.map((r) => r.email)).toEqual(['ana@example.com', 'bob@example.com']);
  });

  it('a seat request whose invitee holds a seat still seats its new attendees, and rewrites', async () => {
    const { startMs, uid } = await slotBookedBeforeSeats();
    const seat = (attendee: string, others: string[]) =>
      createBooking(db, {
        accountCode: 'acme',
        handle: 'alex-rivera',
        slug: 'office',
        startMs,
        attendee: { name: attendee, email: `${attendee}@example.com`, timeZone: 'UTC' },
        additionalAttendees: others.map((o) => ({ name: o, email: `${o}@example.com`, timeZone: 'UTC' })),
      });
    // Alice again, bringing Carl: Carl takes a seat, Alice does not take a second.
    expect(await seat('alice', ['carl'])).toMatchObject({ ok: true, seatTaken: true });
    // Everyone already seated: a replay.
    expect(await seat('alice', ['carl'])).toMatchObject({ ok: true, deduplicated: true });
    const rows = await db.all<{ email: string }>(
      sql`SELECT email FROM booking_attendee WHERE booking_id = (SELECT id FROM booking WHERE uid = ${uid}) ORDER BY created_at`,
    );
    expect(rows.map((r) => r.email.toLowerCase())).toEqual(['alice@example.com', 'carl@example.com']);
  });

  it('seats count each person once, however their row was written', async () => {
    const { startMs, uid } = await slotBookedBeforeSeats();
    await db.run(sql`UPDATE event_type SET seats_per_time_slot = 3 WHERE slug = 'office'`);
    const { id: bookingId, event_type_id: eventTypeId } = (await db.get<{ id: string; event_type_id: string }>(
      sql`SELECT id, event_type_id FROM booking WHERE uid = ${uid}`,
    ))!;
    // Alice again, written before the normalized column was filled, and Carl with a tab SQL's trim keeps.
    for (const [id, email] of [
      ['legacy-alice', ' ALICE@example.com '],
      ['legacy-carl', '\tCarl@example.com'],
    ])
      await db.run(sql`INSERT INTO booking_attendee (id, booking_id, name, email, email_normalized, time_zone, created_at)
          VALUES (${id}, ${bookingId}, 'Legacy', ${email}, NULL, 'UTC', ${Date.now()})`);
    // Three rows, two people: one of the three seats is left.
    const a = await getAvailability(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'office',
      fromMs: startMs,
      toMs: startMs + 60_000,
    });
    expect(a!.slots.find((s) => new Date(s.startUtc).getTime() === startMs)).toMatchObject({ spotsLeft: 1, capacity: 3 });
    // A hold still fits beside them.
    const hold = {
      accountId,
      eventTypeId,
      memberId: alexId,
      startMs,
      endMs: startMs + 30 * 60_000,
      uid: 'seat-hold',
      releaseAtMs: Date.now() + 600_000,
      now: Date.now(),
    };
    expect(await insertHoldGuarded(db, hold)).toBe('ok');
    await db.run(sql`DELETE FROM slot_reservation WHERE uid = 'seat-hold'`);
    // Carl asking again is a replay, not a second seat; Bob takes the last one.
    expect(await book(startMs, 'Carl', 'carl@example.com')).toMatchObject({ ok: true, deduplicated: true });
    expect(await book(startMs, 'Bob Other', 'bob@example.com')).toMatchObject({ ok: true, seatTaken: true });
    expect(await book(startMs, 'Dana', 'dana@example.com')).toMatchObject({ ok: false, reason: 'SLOT_TAKEN' });
  });

  it("guests added to a group slot take its seats too, in availability, holds and the seat write", async () => {
    const { startMs, uid } = await slotBookedBeforeSeats();
    await db.run(sql`UPDATE event_type SET seats_per_time_slot = 4 WHERE slug = 'office'`);
    const eventTypeId = (await db.get<{ id: string }>(sql`SELECT event_type_id AS id FROM booking WHERE uid = ${uid}`))!.id;
    // Alice, one guest added through v2 and one the booking names in its metadata: three people in four seats.
    expect(await addGuestsToBooking(db, { accountId, uid, guests: [{ email: 'gail@example.com' }] })).toEqual({
      ok: true,
      added: 1,
    });
    await db.run(sql`UPDATE booking SET metadata = ${JSON.stringify({ _guests: ['Meta@example.com'] })} WHERE uid = ${uid}`);
    const spotsLeft = async () => {
      const a = await getAvailability(db, {
        accountCode: 'acme',
        handle: 'alex-rivera',
        slug: 'office',
        fromMs: startMs,
        toMs: startMs + 60_000,
      });
      return a!.slots.find((s) => new Date(s.startUtc).getTime() === startMs)?.spotsLeft ?? 0;
    };
    expect(await spotsLeft()).toBe(1);
    // The guest asking for a seat is already on the slot: a replay, no seat spent.
    expect(await book(startMs, 'Gail', 'GAIL@example.com')).toMatchObject({ ok: true, deduplicated: true });
    // Bob takes the last seat; then the slot is full everywhere.
    expect(await book(startMs, 'Bob Other', 'bob@example.com')).toMatchObject({ ok: true, seatTaken: true });
    expect(await spotsLeft()).toBe(0);
    expect(await book(startMs, 'Dana', 'dana@example.com')).toMatchObject({ ok: false, reason: 'SLOT_TAKEN' });
    expect(
      await insertHoldGuarded(db, {
        accountId,
        eventTypeId,
        memberId: alexId,
        startMs,
        endMs: startMs + 30 * 60_000,
        uid: 'full-slot-hold',
        releaseAtMs: Date.now() + 600_000,
        now: Date.now(),
      }),
    ).toBe('INVALID_SLOT');
  });

  it('a seat request with a blank address is refused, so it can never take seats unseen', async () => {
    const { startMs, uid } = await slotBookedBeforeSeats();
    const before = await db.get<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM booking_attendee WHERE booking_id = (SELECT id FROM booking WHERE uid = ${uid})`,
    );
    for (const email of ['   ', ''])
      expect(await book(startMs, 'Nobody', email)).toEqual({
        ok: false,
        reason: 'INVALID',
        message: 'Every attendee needs an email address.',
      });
    // A blank additional attendee is refused the same way.
    expect(
      await createBooking(db, {
        accountCode: 'acme',
        handle: 'alex-rivera',
        slug: 'office',
        startMs,
        attendee: { name: 'Bob', email: 'bob@example.com', timeZone: 'UTC' },
        additionalAttendees: [{ name: 'Blank', email: ' ', timeZone: 'UTC' }],
      }),
    ).toMatchObject({ ok: false, reason: 'INVALID' });
    const after = await db.get<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM booking_attendee WHERE booking_id = (SELECT id FROM booking WHERE uid = ${uid})`,
    );
    expect(Number(after!.n)).toBe(Number(before!.n));
  });
});

describe('a booking whose calendar event has others on it is shared from the start', () => {
  let db: Db;
  let accountId: string;
  let alexId: string;
  let jordanId: string;

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code='acme'`))!.id;
    alexId = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='alex-rivera'`))!.id;
    jordanId = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='jordan-lee'`))!.id;
    const out = await createEventType(db, accountId, alexId, {
      slug: 'call',
      title: 'Call',
      lengthMinutes: 30,
      bookingFields: [{ name: 'company', label: 'Company', type: 'text', required: false }],
      calendarTitleTemplate: 'Call {{name}} {{form.company}}',
      calendarDescriptionTemplate: 'Phone {{attendee_phone}}\nWith {{host_name}}',
    });
    if (!out.ok) throw new Error('event type failed');
  });

  const stored = async (uid: string) =>
    (await db.get<{ title: string; calendar_description: string | null; seated: number | null }>(
      sql`SELECT title, calendar_description, seated FROM booking WHERE uid = ${uid}`,
    ))!;

  async function firstSlot(): Promise<number> {
    const a = await getAvailability(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'call',
      fromMs: Date.now(),
      toMs: Date.now() + 14 * 86_400_000,
    });
    return new Date(a!.slots[0]!.startUtc).getTime();
  }

  const book = async (others: string[]) => {
    const out = await createBooking(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: 'call',
      startMs: await firstSlot(),
      attendee: { name: 'Ana Private', email: 'ana@example.com', timeZone: 'UTC', phone: '+57 300' },
      additionalAttendees: others.map((o) => ({ name: o, email: `${o}@example.com`, timeZone: 'UTC' })),
      answers: { company: 'Secret Co' },
    });
    if (!out.ok) throw new Error(`book failed: ${'reason' in out ? out.reason : ''}`);
    return out.booking;
  };

  it('a booking with other attendees never carries the invitee data; alone it does', async () => {
    const shared = await book(['bob']);
    expect(shared).toMatchObject({ title: 'Call', calendarDescription: 'With Alex Rivera' });
    expect(await stored(shared.uid)).toEqual({ title: 'Call', calendar_description: 'With Alex Rivera', seated: 1 });
    const alone = await book([]);
    expect(alone.title).toBe('Call Ana Private Secret Co');
    expect((await stored(alone.uid)).seated).toBeNull();
    // The invitee's own address named again is not another person.
    expect((await stored((await book(['ANA'])).uid)).seated).toBeNull();
  });

  it('the team path marks it too, and writes each address once', async () => {
    const team = await createEventType(db, accountId, null, {
      slug: 'team-call',
      title: 'Team call',
      lengthMinutes: 30,
      teamId: (await db.get<{ id: string }>(sql`SELECT id FROM team WHERE slug='sales'`))!.id,
      schedulingType: 'round_robin',
      hostMemberIds: [alexId, jordanId],
      calendarTitleTemplate: 'Team {{name}}',
    });
    if (!team.ok) throw new Error('team event type failed');
    const avail = await getTeamAvailability(db, {
      accountCode: 'acme',
      teamSlug: 'sales',
      slug: 'team-call',
      fromMs: Date.now(),
      toMs: Date.now() + 14 * 86_400_000,
    });
    const out = await createTeamBooking(db, {
      accountCode: 'acme',
      teamSlug: 'sales',
      slug: 'team-call',
      startMs: new Date(avail!.slots[0]!).getTime(),
      attendee: { name: 'Ana Private', email: 'ana@example.com', timeZone: 'UTC' },
      additionalAttendees: ['bob', 'BOB', 'ana'].map((o) => ({ name: o, email: `${o}@example.com`, timeZone: 'UTC' })),
    });
    if (!out.ok) throw new Error('team book failed');
    expect(await stored(out.uid)).toMatchObject({ title: 'Team', seated: 1 });
    const rows = await db.all<{ email: string }>(
      sql`SELECT email FROM booking_attendee WHERE booking_id = (SELECT id FROM booking WHERE uid = ${out.uid}) ORDER BY created_at`,
    );
    expect(rows.map((r) => r.email.toLowerCase())).toEqual(['ana@example.com', 'bob@example.com']);
  });

  it('guests added later make it shared and render it again', async () => {
    const alone = await book([]);
    expect((await stored(alone.uid)).title).toBe('Call Ana Private Secret Co');
    expect(
      await addGuestsToBooking(db, { accountId, uid: alone.uid, guests: [{ email: 'guest@example.com' }] }),
    ).toEqual({ ok: true, added: 1 });
    expect(await stored(alone.uid)).toEqual({ title: 'Call', calendar_description: 'With Alex Rivera', seated: 1 });
    // No guest added: nothing to rewrite, nothing changed.
    expect(await addGuestsToBooking(db, { accountId, uid: alone.uid, guests: [{ email: 'GUEST@example.com' }] })).toEqual(
      { ok: true, added: 0 },
    );
    // Neither the render nor its reset landing: the guests are still added (and written out by the caller).
    const other = await book([]);
    vi.mocked(applyCalendarTemplates).mockResolvedValueOnce(null);
    vi.mocked(applySharedFallback).mockResolvedValueOnce(null);
    expect(
      await addGuestsToBooking(db, { accountId, uid: other.uid, guests: [{ email: 'late@example.com' }] }),
    ).toEqual({ ok: true, added: 1 });
    // The guests came with the safe text, in the same write.
    expect(await stored(other.uid)).toEqual({ title: 'Call', calendar_description: '', seated: 1 });
  });

  it('an attendee the machine API adds makes it shared the same way, and never joins a cancelled booking', async () => {
    const bo = { name: 'Bo Added', email: 'bo@example.com', timeZone: 'UTC' };
    const attendees = async (uid: string) =>
      (
        await db.all<{ email: string }>(
          sql`SELECT email FROM booking_attendee WHERE booking_id = (SELECT id FROM booking WHERE uid = ${uid})`,
        )
      ).map((r) => r.email);
    const alone = await book([]);
    expect((await stored(alone.uid)).title).toBe('Call Ana Private Secret Co');
    expect(await addAttendeeToBooking(db, alone.uid, accountId, bo)).toEqual({ ok: true, added: true });
    expect(await stored(alone.uid)).toEqual({ title: 'Call', calendar_description: 'With Alex Rivera', seated: 1 });
    expect(await attendees(alone.uid)).toEqual(['ana@example.com', 'bo@example.com']);
    // Another account's uid, or none at all, is not found.
    expect(await addAttendeeToBooking(db, alone.uid, 'other-account', bo)).toEqual({ ok: false, reason: 'NOT_FOUND' });
    // A cancelled booking gains nobody.
    const gone = await book([]);
    await db.run(sql`UPDATE booking SET status = 'cancelled' WHERE uid = ${gone.uid}`);
    expect(await addAttendeeToBooking(db, gone.uid, accountId, bo)).toEqual({ ok: false, reason: 'GONE' });
    expect(await attendees(gone.uid)).toEqual(['ana@example.com']);
    expect((await stored(gone.uid)).seated).toBeNull();
    // Neither the render nor its reset landing: the attendee is still added (and written out by the caller).
    const other = await book([]);
    vi.mocked(applyCalendarTemplates).mockResolvedValueOnce(null);
    vi.mocked(applySharedFallback).mockResolvedValueOnce(null);
    expect(await addAttendeeToBooking(db, other.uid, accountId, bo)).toEqual({ ok: true, added: true });
    // The attendee came with the safe text, in the same write.
    expect(await stored(other.uid)).toEqual({ title: 'Call', calendar_description: '', seated: 1 });
  });

  it('the machine API writes an address already on the booking once, and stops at 30 people', async () => {
    const attendees = async (uid: string) =>
      Number(
        (await db.get<{ n: number }>(
          sql`SELECT COUNT(*) AS n FROM booking_attendee WHERE booking_id = (SELECT id FROM booking WHERE uid = ${uid})`,
        ))!.n,
      );
    const one = await book([]);
    const bo = { name: 'Bo Added', email: 'bo@example.com', timeZone: 'UTC' };
    expect(await addAttendeeToBooking(db, one.uid, accountId, bo)).toMatchObject({ ok: true, added: true });
    // A retry, the invitee, or a guest's address: nothing written again (so nothing sent).
    for (const email of [' BO@example.com ', 'ana@example.com']) {
      expect(await addAttendeeToBooking(db, one.uid, accountId, { ...bo, email })).toEqual({ ok: true, added: false });
    }
    expect(await addGuestsToBooking(db, { accountId, uid: one.uid, guests: [{ email: 'gi@example.com' }] })).toMatchObject({
      ok: true,
      added: 1,
    });
    expect(await addAttendeeToBooking(db, one.uid, accountId, { ...bo, email: 'GI@example.com' })).toMatchObject({
      added: false,
    });
    expect(await attendees(one.uid)).toBe(2);

    // 30 people in all (the invitee, Bo, a guest and 27 more): the 31st is refused.
    for (let i = 0; i < 26; i++)
      expect(
        await addAttendeeToBooking(db, one.uid, accountId, { ...bo, email: `p${i}@example.com` }),
      ).toMatchObject({ ok: true, added: true });
    expect(await addAttendeeToBooking(db, one.uid, accountId, { ...bo, email: 'p26@example.com' })).toMatchObject({
      ok: true,
      added: true,
    });
    expect(await addAttendeeToBooking(db, one.uid, accountId, { ...bo, email: 'p27@example.com' })).toEqual({
      ok: false,
      reason: 'LIMIT_EXCEEDED',
    });
    expect(await attendees(one.uid)).toBe(29);
  });

  it('the 30-person cap counts an address listed in more than one place once', async () => {
    const one = await book([]);
    const bo = { name: 'Bo Added', email: 'bo@example.com', timeZone: 'UTC' };
    // A guest on the guest list and in the booking's metadata, as v2 bookings list them.
    expect(await addGuestsToBooking(db, { accountId, uid: one.uid, guests: [{ email: 'gi@example.com' }] })).toMatchObject({
      added: 1,
    });
    await db.run(sql`UPDATE booking SET metadata = ${JSON.stringify({ _guests: ['GI@example.com'] })} WHERE uid = ${one.uid}`);
    // The invitee and the guest are 2 people: 28 more make 30.
    for (let i = 0; i < 28; i++)
      expect(await addAttendeeToBooking(db, one.uid, accountId, { ...bo, email: `p${i}@example.com` })).toMatchObject({
        ok: true,
        added: true,
      });
    expect(await addAttendeeToBooking(db, one.uid, accountId, { ...bo, email: 'p28@example.com' })).toEqual({
      ok: false,
      reason: 'LIMIT_EXCEEDED',
    });
  });

  it('once its event type is deleted, a newcomer gets a neutral title in the host language and no description', async () => {
    // Event types are deleted outright and their bookings stay: nothing renders
    // after the commit, so the text written with the newcomer is the one that stands.
    const byMachine = await book([]);
    const byGuests = await book([]);
    expect(await stored(byMachine.uid)).toEqual({
      title: 'Call Ana Private Secret Co',
      calendar_description: 'Phone +57 300\nWith Alex Rivera',
      seated: null,
    });
    const eventTypeId = (await db.get<{ id: string }>(sql`SELECT id FROM event_type WHERE slug = 'call'`))!.id;
    expect(await deleteEventType(db, accountId, eventTypeId)).toBe(true);

    const bo = { name: 'Bo Added', email: 'bo@example.com', timeZone: 'UTC' };
    expect(await addAttendeeToBooking(db, byMachine.uid, accountId, bo)).toEqual({ ok: true, added: true });
    expect(await stored(byMachine.uid)).toEqual({ title: 'Meeting', calendar_description: '', seated: 1 });

    await db.run(sql`UPDATE member SET locale = 'es' WHERE id = ${alexId}`);
    expect(await addGuestsToBooking(db, { accountId, uid: byGuests.uid, guests: [{ email: 'gi@example.com' }] })).toEqual({
      ok: true,
      added: 1,
    });
    expect(await stored(byGuests.uid)).toEqual({ title: 'Reunión', calendar_description: '', seated: 1 });

    // Already shared: the next newcomer leaves the shared text as it is.
    expect(await addAttendeeToBooking(db, byGuests.uid, accountId, bo)).toEqual({ ok: true, added: true });
    expect(await stored(byGuests.uid)).toEqual({ title: 'Reunión', calendar_description: '', seated: 1 });
  });

  it('an address is compared by its normalized form, whoever wrote the row', async () => {
    const one = await book([]);
    const bookingId = (await db.get<{ id: string }>(sql`SELECT id FROM booking WHERE uid = ${one.uid}`))!.id;
    const legacy = (email: string, normalized: string | null) =>
      db.run(sql`INSERT INTO booking_attendee (id, booking_id, name, email, email_normalized, time_zone, created_at)
          VALUES (${`legacy-${email}`}, ${bookingId}, 'Legacy', ${email}, ${normalized}, 'UTC', ${Date.now()})`);
    // Written before the column was filled: mixed case and spaces, or a tab SQL's trim keeps.
    await legacy('  Cy@Example.COM ', null);
    await legacy('\tEve@Example.com', null);
    // Written by a tool that keeps a display form beside the normalized address.
    await legacy('Dee Display <dee@example.com>', 'dee@example.com');
    const bo = { name: 'Bo Added', timeZone: 'UTC' };
    expect(await addAttendeeToBooking(db, one.uid, accountId, { ...bo, email: 'cy@example.com' })).toEqual({
      ok: true,
      added: false,
    });
    for (const email of ['DEE@example.com', 'eve@example.com'])
      expect(await addAttendeeToBooking(db, one.uid, accountId, { ...bo, email })).toEqual({ ok: true, added: false });
    // v2 guests read the same way: neither is added again as a guest.
    expect(
      await addGuestsToBooking(db, {
        accountId,
        uid: one.uid,
        guests: [{ email: 'cy@example.com' }, { email: 'dee@example.com' }, { email: 'eve@example.com' }],
      }),
    ).toEqual({ ok: true, added: 0 });
    const people = await db.get<{ attendees: number; guests: number }>(
      sql`SELECT (SELECT COUNT(*) FROM booking_attendee WHERE booking_id = ${bookingId}) AS attendees,
                 (SELECT COUNT(*) FROM booking_guest WHERE booking_id = ${bookingId}) AS guests`,
    );
    expect({ attendees: Number(people!.attendees), guests: Number(people!.guests) }).toEqual({ attendees: 4, guests: 0 });
  });

  it('a guest is stored under the normalized address every reader compares', async () => {
    const one = await book([]);
    expect(await addGuestsToBooking(db, { accountId, uid: one.uid, guests: [{ email: ' Pat@Example.com ' }] })).toEqual({
      ok: true,
      added: 1,
    });
    expect(
      await db.get<{ email_normalized: string }>(
        sql`SELECT email_normalized FROM booking_guest WHERE booking_id = (SELECT id FROM booking WHERE uid = ${one.uid})`,
      ),
    ).toEqual({ email_normalized: 'pat@example.com' });
  });

  it('v2 guests are capped on everyone on the booking, each person counted once', async () => {
    const bo = { name: 'Bo Added', timeZone: 'UTC' };
    const guests = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => ({ email: `${prefix}${i}@example.com` }));
    // Attendees the machine API added count too: the invitee and 24 more are 25 people.
    const crowded = await book([]);
    for (let i = 0; i < 24; i++)
      expect(await addAttendeeToBooking(db, crowded.uid, accountId, { ...bo, email: `m${i}@example.com` })).toMatchObject({
        added: true,
      });
    expect(await addGuestsToBooking(db, { accountId, uid: crowded.uid, guests: guests(5, 'g') })).toEqual({ ok: true, added: 5 });
    expect(await addGuestsToBooking(db, { accountId, uid: crowded.uid, guests: guests(1, 'late') })).toEqual({
      ok: false,
      reason: 'LIMIT_EXCEEDED',
    });
    // A guest on the guest list and in the booking's metadata is one person:
    // the invitee and 10 guests are 11, so 19 more fit.
    const listed = await book([]);
    expect(await addGuestsToBooking(db, { accountId, uid: listed.uid, guests: guests(10, 'g') })).toEqual({ ok: true, added: 10 });
    await db.run(
      sql`UPDATE booking SET metadata = ${JSON.stringify({ _guests: guests(10, 'G').map((g) => g.email) })} WHERE uid = ${listed.uid}`,
    );
    expect(await addGuestsToBooking(db, { accountId, uid: listed.uid, guests: guests(19, 'n') })).toEqual({ ok: true, added: 19 });
    expect(await addGuestsToBooking(db, { accountId, uid: listed.uid, guests: guests(1, 'late') })).toEqual({
      ok: false,
      reason: 'LIMIT_EXCEEDED',
    });
    // Someone already on a full booking is not refused: there is nobody to add.
    expect(await addGuestsToBooking(db, { accountId, uid: listed.uid, guests: [{ email: 'G3@example.com' }] })).toEqual({
      ok: true,
      added: 0,
    });
    // An event with more seats than 30 takes as many people as it seats.
    const roomy = await book([]);
    await db.run(sql`UPDATE event_type SET seats_per_time_slot = 40 WHERE slug = 'call'`);
    expect(await addGuestsToBooking(db, { accountId, uid: roomy.uid, guests: guests(39, 'r') })).toEqual({ ok: true, added: 39 });
    expect(await addGuestsToBooking(db, { accountId, uid: roomy.uid, guests: guests(1, 'late') })).toEqual({
      ok: false,
      reason: 'LIMIT_EXCEEDED',
    });
  });

  it('an address that is blank once normalized is refused on every add path, and writes nothing', async () => {
    const one = await book([]);
    const people = async () =>
      Number(
        (await db.get<{ n: number }>(
          sql`SELECT (SELECT COUNT(*) FROM booking_attendee WHERE booking_id = b.id)
                   + (SELECT COUNT(*) FROM booking_guest WHERE booking_id = b.id) AS n
              FROM booking b WHERE b.uid = ${one.uid}`,
        ))!.n,
      );
    const before = await people();
    // Repeated blank adds would each be nobody to the cap and the dedupe.
    for (let i = 0; i < 3; i++)
      expect(await addAttendeeToBooking(db, one.uid, accountId, { name: 'Blank', email: '   ', timeZone: 'UTC' })).toEqual({
        ok: false,
        reason: 'INVALID',
      });
    expect(
      await addGuestsToBooking(db, { accountId, uid: one.uid, guests: [{ email: 'fine@example.com' }, { email: ' ' }] }),
    ).toEqual({ ok: false, reason: 'INVALID' });
    expect(await people()).toBe(before);
    expect((await stored(one.uid)).seated).toBeNull();
  });

  it('the team path refuses a blank attendee address too', async () => {
    const team = await createEventType(db, accountId, null, {
      slug: 'team-blank',
      title: 'Team call',
      lengthMinutes: 30,
      teamId: (await db.get<{ id: string }>(sql`SELECT id FROM team WHERE slug='sales'`))!.id,
      schedulingType: 'round_robin',
      hostMemberIds: [alexId, jordanId],
    });
    if (!team.ok) throw new Error('team event type failed');
    const avail = await getTeamAvailability(db, {
      accountCode: 'acme',
      teamSlug: 'sales',
      slug: 'team-blank',
      fromMs: Date.now(),
      toMs: Date.now() + 14 * 86_400_000,
    });
    const out = await createTeamBooking(db, {
      accountCode: 'acme',
      teamSlug: 'sales',
      slug: 'team-blank',
      startMs: new Date(avail!.slots[0]!).getTime(),
      attendee: { name: 'Ana', email: 'ana@example.com', timeZone: 'UTC' },
      additionalAttendees: [{ name: 'Blank', email: '  ', timeZone: 'UTC' }],
    });
    expect(out).toMatchObject({ ok: false, reason: 'INVALID', message: 'Every attendee needs an email address.' });
  });
});
