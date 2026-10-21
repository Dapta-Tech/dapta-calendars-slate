import { describe, it, expect, beforeEach } from 'vitest';
import { copyFileSync, mkdtempSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { formatTemplateTime } from '@slate/engine';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import { seed } from './seed';
import { createBooking, getAvailability } from './repository';
import {
  createTeamBooking,
  getTeamAvailability,
  loadBookingNotificationContext,
  rescheduleBooking,
} from './parity';
import { rescheduleBookingV2 } from './v2-pilot';
import { loadBookingForCalendarWrite } from './calendar-refs';
import { createEventType, getEventTypeById, updateEventType, type EventTypeInputRepo } from './crud';

/**
 * The calendar event's title and description templates (`calendar-text.ts`):
 * rendered onto the booking on every path that places or moves one, read back
 * by every surface that shows the event. The Postgres twin is
 * `calendar-text.pg.spec.ts`.
 */
describe('calendar title and description templates', () => {
  let db: Db;
  let accountId: string;
  let alexId: string;
  let jordanId: string;
  let teamId: string;

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code='acme'`))!.id;
    alexId = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='alex-rivera'`))!.id;
    jordanId = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='jordan-lee'`))!.id;
    teamId = (await db.get<{ id: string }>(sql`SELECT id FROM team WHERE slug='sales'`))!.id;
  });

  async function eventType(slug: string, input: Partial<EventTypeInputRepo> = {}) {
    const out = await createEventType(db, accountId, alexId, {
      slug,
      title: 'Demo',
      description: 'A short demo.',
      lengthMinutes: 30,
      bookingFields: [{ name: 'company', label: 'Company', type: 'text', required: false }],
      ...input,
    });
    if (!out.ok) throw new Error(`event type failed: ${out.reason}`);
    return out.value;
  }

  async function slots(slug: string): Promise<number[]> {
    const a = await getAvailability(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug,
      fromMs: Date.now(),
      toMs: Date.now() + 14 * 86_400_000,
    });
    return a!.slots.map((s) => new Date(s.startUtc).getTime());
  }

  async function book(slug: string, startMs: number, name = 'Ana María López', answers: Record<string, unknown> = {}) {
    const out = await createBooking(db, {
      accountCode: 'acme',
      handle: 'alex-rivera',
      slug,
      startMs,
      attendee: { name, email: `${name.split(' ')[0]!.toLowerCase()}@example.com`, timeZone: 'America/Bogota', phone: '+57 300' },
      answers,
    });
    if (!out.ok) throw new Error(`book failed: ${out.reason}`);
    return out.booking;
  }

  const stored = async (uid: string) =>
    (await db.get<{ title: string; calendar_description: string | null }>(
      sql`SELECT title, calendar_description FROM booking WHERE uid = ${uid}`,
    ))!;

  it('renders the title and the description onto the booking, and every reader sees them', async () => {
    await eventType('cal', {
      calendarTitleTemplate: 'Reunión Alex - {{name}}',
      calendarDescriptionTemplate: [
        '{{#if form.company}}Company: {{form.company}}{{/if}}',
        'Phone: {{attendee_phone}}',
        'Not asked: {{form.secret}}',
        'Title: {{event_title}}',
      ].join('\n'),
    });
    const [start] = await slots('cal');
    const b = await book('cal', start!, 'Ana María López', { company: 'Acme', secret: 'hidden' });
    const description = 'Company: Acme\nPhone: +57 300\nTitle: Reunión Alex - Ana María López';

    expect(b.title).toBe('Reunión Alex - Ana María López');
    expect(b.calendarDescription).toBe(description);
    expect(await stored(b.uid)).toEqual({ title: 'Reunión Alex - Ana María López', calendar_description: description });
    expect(await loadBookingForCalendarWrite(db, b.uid)).toMatchObject({
      title: 'Reunión Alex - Ana María López',
      description,
    });
    expect(await loadBookingNotificationContext(db, b.uid)).toMatchObject({
      title: 'Reunión Alex - Ana María López',
      calendarDescription: description,
    });
  });

  it('keeps the event name and no description without templates, and a blank one is none', async () => {
    const et = await eventType('plain', { calendarTitleTemplate: '  ', calendarDescriptionTemplate: '' });
    expect(et).toMatchObject({ calendarTitleTemplate: null, calendarDescriptionTemplate: null });
    const [start] = await slots('plain');
    const b = await book('plain', start!);
    expect(b.title).toBe('Demo');
    expect(b.calendarDescription).toBeUndefined();
    expect(await stored(b.uid)).toEqual({ title: 'Demo', calendar_description: null });
    expect((await loadBookingForCalendarWrite(db, b.uid))!.description).toBeNull();
    expect((await loadBookingNotificationContext(db, b.uid))!.calendarDescription).toBeNull();
  });

  it('falls back to the event name when the title renders empty', async () => {
    await eventType('empty', { calendarTitleTemplate: '{{form.company}}' });
    const [start] = await slots('empty');
    expect((await book('empty', start!)).title).toBe('Demo');
  });

  it('reads the times in the host zone, and a reschedule renders them again', async () => {
    await eventType('timed', {
      calendarTitleTemplate: 'Demo {{start_time}}',
      calendarDescriptionTemplate: 'Starts {{start_time_attendee}} for {{first_name}}',
    });
    const all = await slots('timed');
    const [first, second] = [all[0]!, all.at(-1)!];
    const b = await book('timed', first);
    const at = (ms: number, tz: string) => formatTemplateTime(new Date(ms).toISOString(), tz).replace(/\s+/g, ' ');
    expect(b.title).toBe(`Demo ${at(first, 'America/New_York')}`);
    expect(b.calendarDescription).toBe(`Starts ${formatTemplateTime(new Date(first).toISOString(), 'America/Bogota')} for Ana`);

    const moved = await rescheduleBooking(db, { uid: b.uid, newStartMs: second, byHost: true, accountId });
    expect(moved).toMatchObject({ ok: true });
    expect(await stored(b.uid)).toEqual({
      title: `Demo ${at(second, 'America/New_York')}`,
      calendar_description: `Starts ${formatTemplateTime(new Date(second).toISOString(), 'America/Bogota')} for Ana`,
    });
  });

  it('a v2 reschedule renders on the new booking', async () => {
    await eventType('v2', { calendarDescriptionTemplate: 'At {{start_time}}' });
    const all = await slots('v2');
    const b = await book('v2', all[0]!);
    const moved = await rescheduleBookingV2(db, { accountId, uid: b.uid, newStartMs: all.at(-1)! });
    if (!moved.ok) throw new Error(`reschedule failed: ${moved.reason}`);
    const when = formatTemplateTime(new Date(all.at(-1)!).toISOString(), 'America/New_York');
    expect(await stored(moved.uid)).toEqual({ title: 'Demo', calendar_description: `At ${when}` });
  });

  it('a template written after the booking applies when it moves; without one, a move keeps the text', async () => {
    await eventType('later');
    const all = await slots('later');
    const b = await book('later', all[0]!);
    await db.run(sql`UPDATE event_type SET title = 'Renamed' WHERE slug = 'later'`);
    expect(await rescheduleBooking(db, { uid: b.uid, newStartMs: all[1]!, byHost: true, accountId })).toMatchObject({
      ok: true,
    });
    expect(await stored(b.uid)).toEqual({ title: 'Demo', calendar_description: null });

    await db.run(sql`UPDATE event_type SET calendar_title_template = '{{event_name}}: {{name}}' WHERE slug = 'later'`);
    expect(await rescheduleBooking(db, { uid: b.uid, newStartMs: all.at(-1)!, byHost: true, accountId })).toMatchObject(
      { ok: true },
    );
    expect(await stored(b.uid)).toEqual({ title: 'Renamed: Ana María López', calendar_description: null });
  });

  it('the team path renders, with the team name', async () => {
    const out = await createEventType(db, accountId, null, {
      slug: 'team-cal',
      title: 'Team call',
      lengthMinutes: 30,
      teamId,
      schedulingType: 'round_robin',
      hostMemberIds: [alexId, jordanId],
      calendarTitleTemplate: '{{team_name}}: {{name}} with {{host_name}}',
      calendarDescriptionTemplate: '{{workspace_name}} / {{event_name}}',
    });
    if (!out.ok) throw new Error('team event type failed');
    const team = await getTeamAvailability(db, {
      accountCode: 'acme',
      teamSlug: 'sales',
      slug: 'team-cal',
      fromMs: Date.now(),
      toMs: Date.now() + 14 * 86_400_000,
    });
    const booked = await createTeamBooking(db, {
      accountCode: 'acme',
      teamSlug: 'sales',
      slug: 'team-cal',
      startMs: new Date(team!.slots[0]!).getTime(),
      attendee: { name: 'Sam Lee', email: 'sam@example.com', timeZone: 'UTC' },
    });
    if (!booked.ok) throw new Error(`team book failed: ${booked.reason}`);
    const host = booked.hostMemberId === alexId ? 'Alex Rivera' : 'Jordan Lee';
    expect(await stored(booked.uid)).toEqual({
      title: `Sales: Sam Lee with ${host}`,
      calendar_description: 'Acme Inc. / Team call',
    });
  });

  it('on a seated event, leaves one invitee out of the shared event, and the next seat reads the same one', async () => {
    await eventType('seats', { seatsPerTimeSlot: 3 });
    // Stored past the API's check, as an old template or another writer could.
    await db.run(
      sql`UPDATE event_type SET calendar_title_template = 'Workshop {{host_name}} {{name}}',
            calendar_description_template = 'Host: {{host_email}}
Company: {{form.company}} {{email}}'
          WHERE slug = 'seats'`,
    );
    const [start] = await slots('seats');
    const first = await book('seats', start!, 'Ana López', { company: 'Acme' });
    expect(first.title).toBe('Workshop Alex Rivera');
    expect(first.calendarDescription).toBe('Host: alex@example.com');
    const second = await book('seats', start!, 'Luis Pérez', { company: 'Other' });
    expect(second.uid).toBe(first.uid);
    expect(second).toMatchObject({ title: 'Workshop Alex Rivera', calendarDescription: 'Host: alex@example.com' });
  });

  it('a slot someone took a seat on stays shared after the seats are turned off', async () => {
    const et = await eventType('was-seated', { seatsPerTimeSlot: 3 });
    const all = await slots('was-seated');
    const first = await book('was-seated', all[0]!, 'Ana López', { company: 'Acme' });
    await book('was-seated', all[0]!, 'Luis Pérez', { company: 'Other' });
    expect((await db.get<{ seated: number }>(sql`SELECT seated FROM booking WHERE uid = ${first.uid}`))!.seated).toBe(1);
    // The host turns seats off and writes a personal template: the shared slot
    // must still never name Ana to Luis, on either move.
    await updateEventType(db, accountId, et.id, {
      seatsPerTimeSlot: null,
      calendarTitleTemplate: 'Call {{name}} {{form.company}}',
      calendarDescriptionTemplate: 'Phone {{attendee_phone}}\nWith {{host_name}}',
    });
    expect(await rescheduleBooking(db, { uid: first.uid, newStartMs: all.at(-1)!, byHost: true, accountId })).toMatchObject({
      ok: true,
    });
    expect(await stored(first.uid)).toEqual({ title: 'Call', calendar_description: 'With Alex Rivera' });
    const moved = await rescheduleBookingV2(db, { accountId, uid: first.uid, newStartMs: all[1]! });
    if (!moved.ok) throw new Error(`v2 reschedule failed: ${moved.reason}`);
    expect(await stored(moved.uid)).toEqual({ title: 'Call', calendar_description: 'With Alex Rivera' });
    // A slot nobody else took is the invitee's own.
    const alone = await book('was-seated', all[2]!, 'Eva Ruiz', { company: 'Solo' });
    expect(alone.title).toBe('Call Eva Ruiz Solo');
  });

  it('a seat taken on a slot booked before the seats existed never reads its first booker', async () => {
    const et = await eventType('late-seats', {
      calendarTitleTemplate: 'Office hours - {{name}}',
      calendarDescriptionTemplate: 'Phone {{attendee_phone}}\nTopic {{form.company}}',
    });
    const [start] = await slots('late-seats');
    const alice = await book('late-seats', start!, 'Alice Secret', { company: 'Private matter' });
    expect(alice.title).toBe('Office hours - Alice Secret');
    // Seats on, templates cleared (a save the gate allows): the stored text is still Alice's.
    await updateEventType(db, accountId, et.id, {
      seatsPerTimeSlot: 10,
      calendarTitleTemplate: null,
      calendarDescriptionTemplate: null,
    });
    const bob = await book('late-seats', start!, 'Bob Other', { company: 'Mine' });
    expect(bob.uid).toBe(alice.uid);
    expect(bob.title).toBe('Demo');
    expect(bob.calendarDescription ?? null).toBeNull();
    expect(await stored(alice.uid)).toEqual({ title: 'Demo', calendar_description: '' });
    // With a shared template, everyone reads that one.
    await updateEventType(db, accountId, et.id, { calendarTitleTemplate: 'Office hours with {{host_name}}' });
    const cleo = await book('late-seats', start!, 'Cleo Third', {});
    expect(cleo.title).toBe('Office hours with Alex Rivera');
  });

  it('a description the template no longer writes is emptied on the next move', async () => {
    const et = await eventType('cleared', { calendarDescriptionTemplate: 'At {{start_time}}' });
    const all = await slots('cleared');
    const b = await book('cleared', all[0]!);
    expect((await stored(b.uid)).calendar_description).toMatch(/^At /);
    await updateEventType(db, accountId, et.id, { calendarDescriptionTemplate: null });
    expect(await rescheduleBooking(db, { uid: b.uid, newStartMs: all.at(-1)!, byHost: true, accountId })).toMatchObject({
      ok: true,
    });
    // Emptied, not NULL: the calendar move clears the old body.
    expect(await stored(b.uid)).toEqual({ title: 'Demo', calendar_description: '' });
    expect((await loadBookingForCalendarWrite(db, b.uid))!.description).toBe('');
    expect((await loadBookingNotificationContext(db, b.uid))!.calendarDescription).toBeNull();
    // A template that now prints nothing empties it the same way.
    await updateEventType(db, accountId, et.id, { calendarDescriptionTemplate: 'Co: {{form.company}}' });
    const again = await book('cleared', all[1]!);
    expect(again.calendarDescription).toBeUndefined();
    expect(await stored(again.uid)).toEqual({ title: 'Demo', calendar_description: null });
  });

  it('the event type stores, reads and clears the templates', async () => {
    const et = await eventType('crud', { calendarTitleTemplate: 'A {{name}}', calendarDescriptionTemplate: 'B' });
    expect(et).toMatchObject({ calendarTitleTemplate: 'A {{name}}', calendarDescriptionTemplate: 'B' });
    // Omitted: unchanged.
    await updateEventType(db, accountId, et.id, { title: 'Other' });
    expect(await getEventTypeById(db, accountId, et.id)).toMatchObject({
      calendarTitleTemplate: 'A {{name}}',
      calendarDescriptionTemplate: 'B',
    });
    const updated = await updateEventType(db, accountId, et.id, {
      calendarTitleTemplate: null,
      calendarDescriptionTemplate: ' \n ',
    });
    expect(updated).toMatchObject({ ok: true, value: { calendarTitleTemplate: null, calendarDescriptionTemplate: null } });
  });

  it('a broken stored template never fails the booking', async () => {
    await eventType('broken', { calendarTitleTemplate: '{{#if name}}Hi', calendarDescriptionTemplate: '{{' });
    const [start] = await slots('broken');
    const b = await book('broken', start!);
    expect(b).toMatchObject({ title: '{{#if name}}Hi', calendarDescription: '{{' });
  });
});

describe('migration 0029 marks the shared slots that already exist', () => {
  it('flags every booking with more than one attendee or an added guest, and no booker alone', async () => {
    const source = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations', 'sqlite');
    const root = mkdtempSync(join(tmpdir(), 'slate-mig-'));
    mkdirSync(join(root, 'sqlite'));
    const files = readdirSync(source).filter((f) => f.endsWith('.sql')).sort();
    const target = files.find((f) => f.startsWith('0029_'))!;
    expect(target).toBe('0029_booking_seated_backfill.sql');
    for (const f of files.filter((f) => f < target)) copyFileSync(join(source, f), join(root, 'sqlite', f));

    const db = await createDb('file::memory:');
    await migrate(db, root);
    await seed(db);
    const ids = (await db.get<{ account_id: string; member_id: string; et: string }>(
      sql`SELECT e.account_id, e.member_id, e.id AS et FROM event_type e WHERE e.slug = 'intro-call'`,
    ))!;
    const plainEt = (await db.get<{ id: string }>(sql`SELECT id FROM event_type WHERE slug = 'team-demo'`))!.id;
    const now = Date.now();
    const booking = async (attendees: number, eventTypeId = ids.et) => {
      const id = randomUUID();
      await db.run(
        sql`INSERT INTO booking (id, account_id, uid, event_type_id, host_member_id, title, start_ms, end_ms, status, created_at, updated_at)
            VALUES (${id}, ${ids.account_id}, ${randomUUID()}, ${eventTypeId}, ${ids.member_id}, 'Intro Call', ${now}, ${now + 1}, 'accepted', ${now}, ${now})`,
      );
      for (let i = 0; i < attendees; i++)
        await db.run(
          sql`INSERT INTO booking_attendee (id, booking_id, name, email, time_zone, created_at)
              VALUES (${randomUUID()}, ${id}, ${'A'}, ${`a${i}@example.com`}, 'UTC', ${now})`,
        );
      return id;
    };
    await db.run(sql`UPDATE event_type SET seats_per_time_slot = 3 WHERE id = ${ids.et}`);
    const shared = await booking(2);
    const single = await booking(1);
    // Seats turned off since, or a booker who brought a guest: both share the
    // event with someone else, so both are marked.
    const withGuest = await booking(2, plainEt);
    // One attendee plus a guest added afterwards: shared too.
    const addedGuest = await booking(1, plainEt);
    await db.run(
      sql`INSERT INTO booking_guest (id, booking_id, email, email_normalized, created_at)
          VALUES (${randomUUID()}, ${addedGuest}, 'g@example.com', 'g@example.com', ${now})`,
    );

    copyFileSync(join(source, target), join(root, 'sqlite', target));
    expect(await migrate(db, root)).toEqual([target]);
    const seated = async (id: string) =>
      (await db.get<{ seated: number | null }>(sql`SELECT seated FROM booking WHERE id = ${id}`))!.seated;
    expect(await seated(shared)).toBe(1);
    expect(await seated(single)).toBeNull();
    expect(await seated(withGuest)).toBe(1);
    expect(await seated(addedGuest)).toBe(1);
    await db.close();
  });
});
