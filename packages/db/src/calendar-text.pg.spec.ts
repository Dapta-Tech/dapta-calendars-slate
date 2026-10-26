import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { formatTemplateTime } from '@slate/engine';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import { seed } from './seed';
import { createBooking, getAccountByCode, getAvailability } from './repository';
import {
  createTeamBooking,
  getTeamAvailability,
  insertHoldGuarded,
  loadBookingNotificationContext,
  rescheduleBooking,
} from './parity';
import { addAttendeeToBooking, addGuestsToBooking, rescheduleBookingV2 } from './v2-pilot';
import { loadBookingForCalendarWrite } from './calendar-refs';
import { createEventType, updateEventType, type EventTypeInputRepo } from './crud';

/**
 * The calendar title and description templates on real Postgres: the three new
 * columns (migrations 0029 and 0030), the render on the personal, team and seat paths,
 * both reschedules and the event type round trip. Every event type here is the
 * run's own, so the seeded ones other files book keep their plain titles. The
 * SQLite twin is `calendar-text.spec.ts`. Skipped on the SQLite dev default.
 */
const url = process.env.DATABASE_URL ?? '';
const isPg = url.startsWith('postgres://') || url.startsWith('postgresql://');
const describePg = isPg ? describe : describe.skip;

describePg('calendar title and description templates (real Postgres)', () => {
  let db: Db;
  let accountId: string;
  let alexId: string;
  let jordanId: string;
  let teamId: string;
  // One tag per run, so the file runs again on the database it ran on.
  const run = randomUUID().slice(0, 8);

  beforeAll(async () => {
    db = await createDb(url);
    await migrate(db);
    // Seed only if the demo account is missing (see repository.pg.spec.ts).
    const existing = await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='alex-rivera'`);
    if (!existing) await seed(db);
    accountId = (await getAccountByCode(db, 'acme'))!.id;
    alexId = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='alex-rivera'`))!.id;
    jordanId = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='jordan-lee'`))!.id;
    teamId = (await db.get<{ id: string }>(sql`SELECT id FROM team WHERE slug='sales' AND account_id = ${accountId}`))!.id;
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  async function eventType(name: string, input: Partial<EventTypeInputRepo> = {}) {
    const out = await createEventType(db, accountId, alexId, {
      slug: `${name}-${run}`,
      title: 'Demo',
      lengthMinutes: 30,
      bookingFields: [{ name: 'company', label: 'Company', type: 'text', required: false }],
      ...input,
    });
    if (!out.ok) throw new Error(`event type failed: ${out.reason}`);
    return out.value;
  }

  // From the END of the window: the other files book the first free slots.
  async function slots(slug: string): Promise<number[]> {
    const a = await getAvailability(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug,
      fromMs: Date.now(),
      toMs: Date.now() + 20 * 86_400_000,
    });
    return a!.slots.map((s) => new Date(s.startUtc).getTime()).reverse();
  }

  async function book(slug: string, startMs: number, name: string, answers: Record<string, unknown> = {}) {
    const out = await createBooking(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug,
      startMs,
      attendee: { name, email: `${name.split(' ')[0]!.toLowerCase()}-${run}@example.com`, timeZone: 'UTC' },
      answers,
    });
    if (!out.ok) throw new Error(`book failed: ${out.reason}`);
    return out.booking;
  }

  const stored = async (uid: string) =>
    (await db.get<{ title: string; calendar_description: string | null }>(
      sql`SELECT title, calendar_description FROM booking WHERE uid = ${uid}`,
    ))!;

  it('renders onto the booking, the readers see it, and both reschedules render again', async () => {
    const et = await eventType('cal', {
      calendarTitleTemplate: 'Reunión Alex - {{name}}',
      calendarDescriptionTemplate: 'Company: {{form.company}}\nAt {{start_time}}',
    });
    const [a, b, c] = await slots(et.slug);
    const at = (ms: number) => formatTemplateTime(new Date(ms).toISOString(), 'America/New_York');
    const created = await book(et.slug, a!, 'Ana López', { company: 'Acme' });
    expect(created.title).toBe('Reunión Alex - Ana López');
    expect(await stored(created.uid)).toEqual({
      title: 'Reunión Alex - Ana López',
      calendar_description: `Company: Acme\nAt ${at(a!)}`,
    });
    expect(await loadBookingForCalendarWrite(db, created.uid)).toMatchObject({
      description: `Company: Acme\nAt ${at(a!)}`,
    });
    expect(await loadBookingNotificationContext(db, created.uid)).toMatchObject({
      calendarDescription: `Company: Acme\nAt ${at(a!)}`,
    });

    expect(await rescheduleBooking(db, { uid: created.uid, newStartMs: b!, byHost: true, accountId })).toMatchObject({
      ok: true,
    });
    expect((await stored(created.uid)).calendar_description).toBe(`Company: Acme\nAt ${at(b!)}`);

    const moved = await rescheduleBookingV2(db, { accountId, uid: created.uid, newStartMs: c! });
    if (!moved.ok) throw new Error(`v2 reschedule failed: ${moved.reason}`);
    expect(await stored(moved.uid)).toEqual({
      title: 'Reunión Alex - Ana López',
      calendar_description: `Company: Acme\nAt ${at(c!)}`,
    });
  });

  it('keeps the plain title without templates, and the event type clears them', async () => {
    const et = await eventType('plain', { calendarTitleTemplate: 'X {{name}}' });
    const cleared = await updateEventType(db, accountId, et.id, { calendarTitleTemplate: '' });
    expect(cleared).toMatchObject({ ok: true, value: { calendarTitleTemplate: null, calendarDescriptionTemplate: null } });
    const [a] = await slots(et.slug);
    const created = await book(et.slug, a!, 'Pat Diaz');
    expect(await stored(created.uid)).toEqual({ title: 'Demo', calendar_description: null });
  });

  it('a seated event leaves one invitee out, and the team path renders the team name', async () => {
    const et = await eventType('seats', { seatsPerTimeSlot: 3 });
    await db.run(
      sql`UPDATE event_type SET calendar_title_template = 'Workshop {{host_name}} {{name}} {{form.company}}'
          WHERE id = ${et.id}`,
    );
    const [a] = await slots(et.slug);
    const first = await book(et.slug, a!, 'Ana López', { company: 'Acme' });
    const second = await book(et.slug, a!, 'Luis Pérez', { company: 'Other' });
    expect(second.uid).toBe(first.uid);
    expect(first.title).toBe('Workshop Alex Rivera');
    expect(second.title).toBe('Workshop Alex Rivera');

    const team = await createEventType(db, accountId, null, {
      slug: `team-${run}`,
      title: 'Team call',
      lengthMinutes: 30,
      teamId,
      schedulingType: 'round_robin',
      hostMemberIds: [alexId, jordanId],
      calendarTitleTemplate: '{{team_name}}: {{name}}',
    });
    if (!team.ok) throw new Error('team event type failed');
    const avail = await getTeamAvailability(db, {
      accountCode: 'acme',
      teamSlug: 'sales',
      slug: `team-${run}`,
      fromMs: Date.now(),
      toMs: Date.now() + 20 * 86_400_000,
    });
    const booked = await createTeamBooking(db, {
      accountCode: 'acme',
      teamSlug: 'sales',
      slug: `team-${run}`,
      startMs: new Date(avail!.slots.at(-1)!).getTime(),
      attendee: { name: 'Sam Lee', email: `sam-${run}@example.com`, timeZone: 'UTC' },
    });
    if (!booked.ok) throw new Error(`team book failed: ${booked.reason}`);
    expect((await stored(booked.uid)).title).toBe('Sales: Sam Lee');

    // Seats off and a personal template: the slot two people took stays shared.
    await updateEventType(db, accountId, et.id, { seatsPerTimeSlot: null, calendarTitleTemplate: 'Call {{name}}' });
    const [, later] = await slots(et.slug);
    expect(await rescheduleBooking(db, { uid: first.uid, newStartMs: later!, byHost: true, accountId })).toMatchObject({
      ok: true,
    });
    expect((await stored(first.uid)).title).toBe('Call');
  });

  it('a description the template no longer writes is emptied on the next move', async () => {
    const et = await eventType('cleared', { calendarDescriptionTemplate: 'At {{start_time}}' });
    const [a, b] = await slots(et.slug);
    const created = await book(et.slug, a!, 'Cleo Diaz');
    await updateEventType(db, accountId, et.id, { calendarDescriptionTemplate: null });
    expect(await rescheduleBooking(db, { uid: created.uid, newStartMs: b!, byHost: true, accountId })).toMatchObject({
      ok: true,
    });
    expect(await stored(created.uid)).toEqual({ title: 'Demo', calendar_description: '' });
  });

  it('guests added while a v2 move copies the booking never reach a copy that shows the invitee', async () => {
    const et = await eventType('race', { calendarTitleTemplate: 'Call {{name}}' });
    const times = await slots(et.slug);
    for (let round = 0; round < 4; round++) {
      const created = await book(et.slug, times[round * 2]!, `Ana${round} Private`);
      const [guests, moved] = await Promise.all([
        addGuestsToBooking(db, { accountId, uid: created.uid, guests: [{ email: `g${round}-${run}@example.com` }] }),
        rescheduleBookingV2(db, { accountId, uid: created.uid, newStartMs: times[round * 2 + 1]! }),
      ]);
      if (!moved.ok) throw new Error(`v2 reschedule failed: ${moved.reason}`);
      // The guests land either on the booking before the move (and are copied
      // with the mark) or not at all (the move cancelled it first).
      const copy = (await db.get<{ title: string; seated: number | null; guests: number | string }>(
        sql`SELECT b.title, b.seated, (SELECT COUNT(*) FROM booking_guest g WHERE g.booking_id = b.id) AS guests
            FROM booking b WHERE b.uid = ${moved.uid}`,
      ))!;
      if (guests.ok && guests.added > 0) {
        expect(Number(copy.guests), `round ${round}`).toBe(1);
        expect(copy.seated, `round ${round}`).toBe(1);
        expect(copy.title, `round ${round}`).toBe('Call');
      } else {
        expect(guests, `round ${round}`).toEqual({ ok: false, reason: 'GONE' });
        expect(Number(copy.guests), `round ${round}`).toBe(0);
      }
    }
  });

  it('an attendee the machine API adds while a v2 move copies the booking never reaches a copy that shows the invitee', async () => {
    const et = await eventType('race-attendee', { calendarTitleTemplate: 'Call {{name}}' });
    const times = await slots(et.slug);
    for (let round = 0; round < 4; round++) {
      const created = await book(et.slug, times[round * 2]!, `Ana${round} Private`);
      const email = `a${round}-${run}@example.com`;
      const [added, moved] = await Promise.all([
        addAttendeeToBooking(db, created.uid, accountId, { name: 'Bo Added', email, timeZone: 'UTC' }),
        rescheduleBookingV2(db, { accountId, uid: created.uid, newStartMs: times[round * 2 + 1]! }),
      ]);
      if (!moved.ok) throw new Error(`v2 reschedule failed: ${moved.reason}`);
      // The attendee lands either on the booking before the move (and is
      // copied with the mark) or not at all (the move cancelled it first).
      const copy = (await db.get<{ title: string; seated: number | null; hits: number | string }>(
        sql`SELECT b.title, b.seated,
              (SELECT COUNT(*) FROM booking_attendee a WHERE a.booking_id = b.id AND a.email = ${email}) AS hits
            FROM booking b WHERE b.uid = ${moved.uid}`,
      ))!;
      if (added.ok) {
        expect(Number(copy.hits), `round ${round}`).toBe(1);
        expect(copy.seated, `round ${round}`).toBe(1);
        expect(copy.title, `round ${round}`).toBe('Call');
      } else {
        expect(added, `round ${round}`).toEqual({ ok: false, reason: 'GONE' });
        expect(Number(copy.hits), `round ${round}`).toBe(0);
      }
    }
  });

  it('an attendee waiting on the booking lock reads its status again there, and never joins it once cancelled', async () => {
    const et = await eventType('lock-attendee');
    const created = await book(et.slug, (await slots(et.slug))[0]!, 'Ana Private');
    const email = `late-${run}@example.com`;
    let pending: ReturnType<typeof addAttendeeToBooking> | undefined;
    // Another writer holds the row (as a v2 move does) while the add starts:
    // the add reads the booking live, then waits; the holder cancels it.
    await db.pg!.drizzle.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM booking WHERE uid = ${created.uid} FOR UPDATE`);
      pending = addAttendeeToBooking(db, created.uid, accountId, { name: 'Bo Late', email, timeZone: 'UTC' });
      await new Promise((r) => setTimeout(r, 200));
      await tx.execute(sql`UPDATE booking SET status = 'cancelled' WHERE uid = ${created.uid}`);
    });
    expect(await pending).toEqual({ ok: false, reason: 'GONE' });
    const row = (await db.get<{ hits: number | string; seated: number | null }>(
      sql`SELECT (SELECT COUNT(*) FROM booking_attendee a WHERE a.booking_id = b.id AND a.email = ${email}) AS hits, b.seated
          FROM booking b WHERE b.uid = ${created.uid}`,
    ))!;
    expect(Number(row.hits)).toBe(0);
    expect(row.seated).toBeNull();
  });

  it('a group slot counts each person once for its seats, its holds and its seat writes', async () => {
    const et = await eventType('people', { seatsPerTimeSlot: 3 });
    const startMs = (await slots(et.slug))[1]!;
    const seat = (name: string) =>
      createBooking(db, {
        accountCode: 'acme',
        handle: 'alex-rivera',
        slug: et.slug,
        startMs,
        attendee: { name, email: `${name.toLowerCase()}-${run}@example.com`, timeZone: 'UTC' },
      });
    const first = await seat('Alice');
    if (!first.ok) throw new Error('first seat failed');
    const bookingId = (await db.get<{ id: string }>(sql`SELECT id FROM booking WHERE uid = ${first.booking.uid}`))!.id;
    // Alice again, written before the normalized column was filled, and Carl with a tab SQL's trim keeps.
    for (const email of [` ALICE-${run}@Example.com `, `\tCarl-${run}@example.com`])
      await db.run(sql`INSERT INTO booking_attendee (id, booking_id, name, email, email_normalized, time_zone, created_at)
          VALUES (${randomUUID()}, ${bookingId}, 'Legacy', ${email}, NULL, 'UTC', ${Date.now()})`);
    const a = await getAvailability(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug: et.slug,
      fromMs: startMs,
      toMs: startMs + 60_000,
    });
    expect(a!.slots.find((s) => new Date(s.startUtc).getTime() === startMs)).toMatchObject({ spotsLeft: 1, capacity: 3 });
    const holdUid = `people-hold-${run}`;
    expect(
      await insertHoldGuarded(db, {
        accountId,
        eventTypeId: et.id,
        memberId: alexId,
        startMs,
        endMs: startMs + 30 * 60_000,
        uid: holdUid,
        releaseAtMs: Date.now() + 600_000,
        now: Date.now(),
      }),
    ).toBe('ok');
    await db.run(sql`DELETE FROM slot_reservation WHERE uid = ${holdUid}`);
    expect(await seat('Carl')).toMatchObject({ ok: true, deduplicated: true });
    expect(await seat('Bob')).toMatchObject({ ok: true, seatTaken: true });
    expect(await seat('Dana')).toMatchObject({ ok: false, reason: 'SLOT_TAKEN' });
  });

  it('guests on a group slot take its seats in availability, holds and the seat write', async () => {
    const et = await eventType('guest-seats', { seatsPerTimeSlot: 3 });
    const startMs = (await slots(et.slug))[2]!;
    const seat = (name: string) =>
      createBooking(db, {
        accountCode: 'acme',
        handle: 'alex-rivera',
        slug: et.slug,
        startMs,
        attendee: { name, email: `${name.toLowerCase()}-${run}@example.com`, timeZone: 'UTC' },
      });
    const first = await seat('Alice');
    if (!first.ok) throw new Error('first seat failed');
    const spotsLeft = async () =>
      (
        await getAvailability(db, {
          accountCode: 'acme',
          handle: 'alex-rivera',
          slug: et.slug,
          fromMs: startMs,
          toMs: startMs + 60_000,
        })
      )!.slots.find((s) => new Date(s.startUtc).getTime() === startMs)?.spotsLeft ?? 0;
    const hold = (uid: string) =>
      insertHoldGuarded(db, {
        accountId,
        eventTypeId: et.id,
        memberId: alexId,
        startMs,
        endMs: startMs + 30 * 60_000,
        uid,
        releaseAtMs: Date.now() + 600_000,
        now: Date.now(),
      });
    // Alice and a guest added through v2: two people in three seats.
    expect(
      await addGuestsToBooking(db, { accountId, uid: first.booking.uid, guests: [{ email: `gail-${run}@example.com` }] }),
    ).toEqual({ ok: true, added: 1 });
    expect(await spotsLeft()).toBe(1);
    expect(await hold(`guest-seats-a-${run}`)).toBe('ok');
    await db.run(sql`DELETE FROM slot_reservation WHERE uid = ${`guest-seats-a-${run}`}`);
    // A guest the booking names in its metadata is the third: the slot is full everywhere.
    await db.run(
      sql`UPDATE booking SET metadata = ${JSON.stringify({ _guests: [`Meta-${run}@example.com`] })}::jsonb
          WHERE uid = ${first.booking.uid}`,
    );
    expect(await spotsLeft()).toBe(0);
    expect(await hold(`guest-seats-b-${run}`)).toBe('INVALID_SLOT');
    expect(await seat('Bob')).toMatchObject({ ok: false, reason: 'SLOT_TAKEN' });
  });
});
