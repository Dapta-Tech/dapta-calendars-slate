import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { formatTemplateTime } from '@slate/engine';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import { seed } from './seed';
import { createBooking, getAccountByCode, getAvailability } from './repository';
import { createTeamBooking, getTeamAvailability, loadBookingNotificationContext, rescheduleBooking } from './parity';
import { addGuestsToBooking, rescheduleBookingV2 } from './v2-pilot';
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
});
