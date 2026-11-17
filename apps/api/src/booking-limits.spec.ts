import { describe, it, expect, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { createDb, createTeamBooking, getTeamAvailability, migrate, seed, sql, type Db } from '@slate/db';
import { DisabledCalendarProvider } from '@slate/calendar';
import { loadServerEnv } from '@slate/config/env';
import { BookingNotifier, NoopEmailProvider } from '@slate/notifications';
import { AdminCrudController } from './admin-crud.controller';
import type { AuthService, HostPrincipal, ReqLike } from './auth.service';
import { BookingService } from './booking.service';
import { CalendarEffects } from './calendar-effects';
import { CalV2Service } from './cal-v2.service';
import { CalV2PilotService } from './cal-v2-pilot.service';
import { EmailEffects } from './email-effects';

const ENV = loadServerEnv({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);
const REQ: ReqLike = { headers: {} };
const DAY = 86_400_000;
const hostDay = (instant: string | number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(instant),
  );
const LIMITS = ['maxBookingsPerDay', 'maxBookingsPerWeek', 'maxMinutesPerDay', 'maxMinutesPerWeek'] as const;
const limitsOf = (et: Partial<Record<(typeof LIMITS)[number], unknown>>) => Object.fromEntries(LIMITS.map((k) => [k, et[k]]));
/** What a refusal says when a full day is why. */
const DAY_FULL = /That day has reached this event type's booking limit/;

/**
 * Booking limits on the API: the editor's save, `/v1` and `/v2` reads, and the
 * public REST surface (slots, holds, bookings, the manage link, team pages).
 * A full day or week offers no times and lists them as `fullSlots`; a booking
 * past a limit is refused the way a time that is no longer offered is.
 */
describe('booking limits on event types', () => {
  let db: Db;
  let crud: AdminCrudController;
  let bookings: BookingService;
  let accountId: string;
  let introId: string;
  let teamEventId: string;
  /** The seed's accepted Intro Call: its day is D. */
  let seeded: { uid: string; start_ms: number };

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    const m = (await db.get<{ id: string; account_id: string }>(sql`SELECT id, account_id FROM member WHERE handle='alex-rivera'`))!;
    accountId = m.account_id;
    const principal: HostPrincipal = { accountId, memberId: m.id, role: 'owner' };
    crud = new AdminCrudController(db, { resolveHost: () => Promise.resolve(principal) } as unknown as AuthService);
    bookings = new BookingService(db, ENV, new CalendarEffects(new DisabledCalendarProvider(), db), new EmailEffects(new BookingNotifier(new NoopEmailProvider()), db));
    introId = (await db.get<{ id: string }>(sql`SELECT id FROM event_type WHERE slug='intro-call'`))!.id;
    teamEventId = (await db.get<{ id: string }>(sql`SELECT id FROM event_type WHERE slug='team-demo'`))!.id;
    seeded = (await db.get<{ uid: string; start_ms: number }>(sql`SELECT uid, start_ms FROM booking WHERE event_type_id = ${introId}`))!;
  });

  const window = () => ({ from: new Date().toISOString(), to: new Date(Date.now() + 14 * DAY).toISOString() });
  const personal = async () => (await bookings.availability({ accountCode: 'acme', handle: 'alex-rivera', slug: 'intro-call', ...window() }))!;
  const team = async () => (await bookings.teamAvailability('acme', 'sales', 'team-demo', window().from, window().to))!;
  const on = (slots: Array<{ startUtc: string } | string>, day: string) =>
    slots.map((s) => (typeof s === 'string' ? s : s.startUtc)).filter((s) => hostDay(s) === day);
  const book = (startUtc: string, email: string, reservationUid?: string) =>
    bookings.book({
      accountCode: 'acme', handle: 'alex-rivera', slug: 'intro-call', startUtc, reservationUid,
      attendee: { name: 'Limit Tester', email, timeZone: 'UTC' }, answers: { company: 'Acme' },
    });
  /** Days with at least three times, in order (today may have fewer left). */
  const roomyDays = (slots: Array<{ startUtc: string }>) =>
    [...new Set(slots.map((s) => hostDay(s.startUtc)))].filter((d) => on(slots, d).length >= 3);
  /** Roomy days other than D. */
  const otherDays = async () => roomyDays((await personal()).slots).filter((d) => d !== hostDay(seeded.start_ms));

  it('saves the four limits on /v1, reads them back, keeps them when omitted, clears with null, refuses out of range, lists them on /v2', async () => {
    const set = { maxBookingsPerDay: 3, maxBookingsPerWeek: 10, maxMinutesPerDay: 120, maxMinutesPerWeek: 600 };
    expect(limitsOf(await crud.updateEventType(REQ, introId, set))).toEqual(set);
    expect(limitsOf(await crud.updateEventType(REQ, introId, { title: 'Renamed' }))).toEqual(set);
    expect(limitsOf(await crud.getEventType(REQ, teamEventId))).toEqual(Object.fromEntries(LIMITS.map((k) => [k, null])));
    for (const [key, bad] of [['maxBookingsPerDay', 0], ['maxBookingsPerWeek', 1.5], ['maxMinutesPerDay', 1441], ['maxMinutesPerWeek', 10081]] as const) {
      await expect(crud.updateEventType(REQ, introId, { [key]: bad })).rejects.toBeInstanceOf(BadRequestException);
    }
    expect((await crud.updateEventType(REQ, introId, { maxBookingsPerDay: null })).maxBookingsPerDay).toBeNull();
    const pilot = new CalV2PilotService(db, new CalendarEffects(new DisabledCalendarProvider(), db), bookings, new CalV2Service(bookings, db));
    const rows = await pilot.eventTypes(accountId, {});
    expect(rows.find((r) => r.slug === 'intro-call')).toMatchObject({
      bookingLimitsCount: { week: 10 },
      bookingLimitsDuration: { day: 120, week: 600 },
    });
    expect(rows.find((r) => r.slug === 'team-demo')).toMatchObject({ bookingLimitsCount: null, bookingLimitsDuration: null });
  });

  it('a full day offers no times and lists them as full; pending counts; cancelled and declined free it', async () => {
    const D = hostDay(seeded.start_ms);
    expect(on((await personal()).slots, D).length).toBeGreaterThan(1);
    await crud.updateEventType(REQ, introId, { maxBookingsPerDay: 1 });
    const full = await personal();
    expect(on(full.slots, D)).toEqual([]);
    expect(on(full.fullSlots ?? [], D).length).toBeGreaterThan(1);
    expect(full.slots.length).toBeGreaterThan(0);
    for (const [status, open] of [['cancelled', true], ['pending', false], ['rejected', true]] as const) {
      await db.run(sql`UPDATE booking SET status = ${status} WHERE uid = ${seeded.uid}`);
      expect(on((await personal()).slots, D).length > 0, status).toBe(open);
    }
  });

  it('on a seated event the booked time keeps taking seats while the rest of the day is full', async () => {
    await crud.updateEventType(REQ, introId, { maxBookingsPerDay: 1, seatsPerTimeSlot: 3 });
    expect(on((await personal()).slots, hostDay(seeded.start_ms))).toEqual([new Date(seeded.start_ms).toISOString()]);
  });

  it('a team event counts the bookings of every host', async () => {
    const X = roomyDays((await team()).slots)[0]!;
    const first = { startUtc: on((await team()).slots, X)[0]! };
    await crud.updateEventType(REQ, teamEventId, { maxBookingsPerDay: 1 });
    const made = await bookings.teamBook('acme', 'sales', { slug: 'team-demo', startUtc: first.startUtc, attendee: { name: 'T', email: 't@example.com', timeZone: 'UTC' } });
    expect('error' in made).toBe(false);
    const after = await team();
    expect(on(after.slots, X)).toEqual([]);
    expect(on(after.fullSlots ?? [], X).length).toBeGreaterThan(0);
  });

  it("a team event reads its days in the team's zone: what it offers is bookable, and one team day never holds two", async () => {
    // Round robin, 1 a day, a host in New York and one in Madrid. D is ten days out (UTC).
    const d = new Date(Date.now() + 10 * DAY);
    const at = (days: number, h: number) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + days, h);
    const zonedTeam = async (teamZone: string, nyFrom: string, bookedBy: 'ny' | 'mad') => {
      const [teamId, ev] = [crypto.randomUUID(), crypto.randomUUID()];
      await db.run(sql`INSERT INTO team (id, account_id, name, slug, time_zone, hide_branding, created_at) VALUES (${teamId}, ${accountId}, 'Z', ${`z-${teamId}`}, ${teamZone}, 0, 0)`);
      await db.run(sql`INSERT INTO event_type (id, account_id, team_id, slug, title, length_minutes, scheduling_type, minimum_booking_notice, slot_interval, max_bookings_per_day, created_at)
          VALUES (${ev}, ${accountId}, ${teamId}, 'rr', 'RR', 30, 'round_robin', 0, 30, 1, 0)`);
      const ids: Record<string, string> = {};
      for (const [name, tz, from] of [['ny', 'America/New_York', nyFrom], ['mad', 'Europe/Madrid', '00:00']] as const) {
        const [id, schedule] = [crypto.randomUUID(), crypto.randomUUID()];
        ids[name] = id;
        await db.run(sql`INSERT INTO member (id, account_id, handle, display_name, email, time_zone, default_schedule_id, created_at) VALUES (${id}, ${accountId}, ${`${name}-${id}`}, ${name}, ${`${id}@example.com`}, ${tz}, ${schedule}, 0)`);
        await db.run(sql`INSERT INTO schedule (id, account_id, member_id, name, time_zone, created_at) VALUES (${schedule}, ${accountId}, ${id}, 'H', ${tz}, 0)`);
        await db.run(sql`INSERT INTO availability (id, schedule_id, days, start_time, end_time, date) VALUES (${crypto.randomUUID()}, ${schedule}, '[0,1,2,3,4,5,6]', ${from}, '23:30', NULL)`);
        await db.run(sql`INSERT INTO event_type_host (id, account_id, event_type_id, member_id, is_fixed, priority, weight, schedule_id, created_at) VALUES (${crypto.randomUUID()}, ${accountId}, ${ev}, ${id}, 0, NULL, 100, NULL, 0)`);
      }
      // Day D+1 01:00 UTC: still day D in New York (evening), day D+1 in Madrid.
      await db.run(sql`INSERT INTO booking (id, account_id, uid, event_type_id, host_member_id, team_id, title, start_ms, end_ms, status, metadata, created_at, updated_at)
          VALUES (${crypto.randomUUID()}, ${accountId}, ${crypto.randomUUID()}, ${ev}, ${ids[bookedBy]!}, ${teamId}, 'RR', ${at(1, 1)}, ${at(1, 1) + 1_800_000}, 'accepted', '{}', 0, 0)`);
      const slug = `z-${teamId}`;
      const offered = async (ms: number) =>
        (await getTeamAvailability(db, { accountCode: 'acme', teamSlug: slug, slug: 'rr', fromMs: ms - 3_600_000, toMs: ms + 3_600_000 }))!.slots.includes(new Date(ms).toISOString());
      const book = (ms: number) => createTeamBooking(db, { accountCode: 'acme', teamSlug: slug, slug: 'rr', startMs: ms, attendee: { name: 'Z', email: `${ms}@example.com`, timeZone: 'UTC' } });
      return { offered, book };
    };
    // A: team zone UTC, Madrid booked D+1. D 13:00 UTC (New York's day D) is offered, so it books.
    const a = await zonedTeam('UTC', '00:00', 'mad');
    expect(await a.offered(at(0, 13))).toBe(true);
    expect((await a.book(at(0, 13))).ok).toBe(true);
    // B: team zone New York, New York booked D. D 09:00 UTC is New York's day D (only Madrid works then): not offered, not booked.
    const b = await zonedTeam('America/New_York', '06:00', 'ny');
    expect(await b.offered(at(0, 9))).toBe(false);
    expect(await b.book(at(0, 9))).toMatchObject({ ok: false, message: expect.stringMatching(DAY_FULL) });
  });

  it('refuses a minutes limit shorter than the event: on create, on a partial update, and when the length grows past it', async () => {
    await expect(crud.updateEventType(REQ, introId, { maxMinutesPerDay: 15 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(crud.createEventType(REQ, { slug: 'm', title: 'M', lengthMinutes: 60, maxMinutesPerWeek: 45 })).rejects.toBeInstanceOf(BadRequestException);
    await crud.updateEventType(REQ, introId, { maxMinutesPerDay: 60 });
    await expect(crud.updateEventType(REQ, introId, { lengthMinutes: 90 })).rejects.toBeInstanceOf(BadRequestException);
    expect(await crud.getEventType(REQ, introId)).toMatchObject({ lengthMinutes: 30, maxMinutesPerDay: 60 });
  });

  it('says the booking limit is why a full day refuses a booking or a hold', async () => {
    await crud.updateEventType(REQ, introId, { maxBookingsPerDay: 1 });
    const intoD = new Date(seeded.start_ms + 60 * 60_000).toISOString();
    expect(await book(intoD, 'late@example.com')).toMatchObject({ error: 'INTAKE_INVALID', message: expect.stringMatching(DAY_FULL) });
    expect(await bookings.reserve({ accountCode: 'acme', handle: 'alex-rivera', slug: 'intro-call', startUtc: intoD })).toMatchObject({
      error: 'INVALID_SLOT',
      message: expect.stringMatching(DAY_FULL),
    });
  });

  it('two people booking the last time of a day: one wins, the other is told it is taken', async () => {
    await crud.updateEventType(REQ, introId, { maxBookingsPerDay: 1 });
    const [E, F] = await otherDays();
    // Holds do not count: both are granted, and the booking write re-counts.
    const [a, b] = on((await personal()).slots, E!);
    const holds = [await bookings.reserve({ accountCode: 'acme', handle: 'alex-rivera', slug: 'intro-call', startUtc: a! }), await bookings.reserve({ accountCode: 'acme', handle: 'alex-rivera', slug: 'intro-call', startUtc: b! })];
    const [r1, r2] = [await book(a!, 'one@example.com', (holds[0] as { reservationUid: string }).reservationUid), await book(b!, 'two@example.com', (holds[1] as { reservationUid: string }).reservationUid)];
    expect('error' in r1).toBe(false);
    expect(r2).toMatchObject({ error: 'SLOT_TAKEN', status: 409, message: expect.stringMatching(DAY_FULL) });
    // At once, without holds: still one.
    const [c, d] = on((await personal()).slots, F!);
    const both = await Promise.all([book(c!, 'three@example.com'), book(d!, 'four@example.com')]);
    expect(both.filter((r) => !('error' in r))).toHaveLength(1);
  });

  it('a reschedule into a full day is refused, and a move within its own day is not', async () => {
    await crud.updateEventType(REQ, introId, { maxBookingsPerDay: 1 });
    const [E] = await otherDays();
    const [start, later] = on((await personal()).slots, E!);
    const made = await book(start!, 'mover@example.com');
    if ('error' in made) throw new Error(made.message);
    const token = new URL(made.manageUrl!).searchParams.get('token')!;
    const intoD = new Date(seeded.start_ms + 60 * 60_000).toISOString();
    expect(await bookings.reschedule(made.uid, { token, newStartUtc: intoD })).toMatchObject({
      error: 'INVALID_SLOT',
      message: expect.stringMatching(DAY_FULL),
    });
    const picker = await bookings.rescheduleAvailability(made.uid, token, window());
    expect(on(picker!.slots, hostDay(seeded.start_ms))).toEqual([]);
    const moved = await bookings.reschedule(made.uid, { token, newStartUtc: later! });
    expect('error' in moved).toBe(false);
  });
});
