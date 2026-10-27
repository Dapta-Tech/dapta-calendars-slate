import { describe, it, expect, beforeEach } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { createBooking, createDb, migrate, seed, sql, type Db } from '@slate/db';
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
/** The seed host's zone, the one the window counts its days in. */
const HOST_TZ = 'America/New_York';
const WINDOW_DAYS = 3;

const hostDay = (instant: string | number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: HOST_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(instant),
  );
function lastWindowDay(): string {
  const [y, m, d] = hostDay(Date.now()).split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + WINDOW_DAYS)).toISOString().slice(0, 10);
}

async function refusalOf(run: Promise<unknown>): Promise<{ error: string; message: string }> {
  try {
    await run;
  } catch (err) {
    expect(err).toBeInstanceOf(BadRequestException);
    return (err as BadRequestException).getResponse() as { error: string; message: string };
  }
  throw new Error('expected the save to be refused');
}

/**
 * The booking window on the API: the editor's save takes 1..730 days or null,
 * `/v1` and `/v2` read it back, and the public REST surface (slots, booking,
 * a reschedule through the manage link, team pages) refuses a later time
 * exactly as it refuses a time that is not offered. The MCP tools have their
 * own spec (`mcp/mcp.booking-window.spec.ts`).
 */
describe('booking window on event types', () => {
  let db: Db;
  let crud: AdminCrudController;
  let bookings: BookingService;
  let accountId: string;
  let introId: string;
  let teamEventId: string;

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    const m = (await db.get<{ id: string; account_id: string }>(
      sql`SELECT id, account_id FROM member WHERE handle='alex-rivera'`,
    ))!;
    accountId = m.account_id;
    const principal: HostPrincipal = { accountId, memberId: m.id, role: 'owner' };
    crud = new AdminCrudController(db, { resolveHost: () => Promise.resolve(principal) } as unknown as AuthService);
    const calendar = new CalendarEffects(new DisabledCalendarProvider(), db);
    bookings = new BookingService(db, ENV, calendar, new EmailEffects(new BookingNotifier(new NoopEmailProvider()), db));
    introId = (await db.get<{ id: string }>(sql`SELECT id FROM event_type WHERE slug='intro-call'`))!.id;
    teamEventId = (await db.get<{ id: string }>(sql`SELECT id FROM event_type WHERE slug='team-demo'`))!.id;
  });

  const window = () => ({ from: new Date().toISOString(), to: new Date(Date.now() + 14 * DAY).toISOString() });
  const personalSlots = async () =>
    (await bookings.availability({ accountCode: 'acme', handle: 'alex-rivera', slug: 'intro-call', ...window() }))!.slots;
  const teamSlots = async () =>
    (await bookings.teamAvailability('acme', 'sales', 'team-demo', window().from, window().to))!.slots;
  const attendee = (email: string) => ({ name: 'Window Tester', email, timeZone: 'UTC' });

  describe('the editor save', () => {
    it('stores a whole number of days and reads it back on /v1; null clears; omitted keeps', async () => {
      expect((await crud.updateEventType(REQ, introId, { bookingWindowDays: 14 })).bookingWindowDays).toBe(14);
      expect((await crud.getEventType(REQ, introId)).bookingWindowDays).toBe(14);
      expect((await crud.updateEventType(REQ, introId, { title: 'Renamed' })).bookingWindowDays).toBe(14);
      expect((await crud.updateEventType(REQ, introId, { bookingWindowDays: null })).bookingWindowDays).toBeNull();
      const created = await crud.createEventType(REQ, { slug: 'w', title: 'W', lengthMinutes: 30, bookingWindowDays: 730 });
      expect(created.bookingWindowDays).toBe(730);
    });

    it('reads as no limit on every event type that predates it', async () => {
      expect((await crud.getEventType(REQ, introId)).bookingWindowDays).toBeNull();
      expect((await crud.getEventType(REQ, teamEventId)).bookingWindowDays).toBeNull();
    });

    it('refuses 0, a fraction, a negative and more than 730 days, and stores nothing', async () => {
      for (const bad of [0, 1.5, -3, 731]) {
        const r = await refusalOf(crud.updateEventType(REQ, introId, { bookingWindowDays: bad }));
        expect(r.error).toBe('BAD_REQUEST');
      }
      expect((await refusalOf(crud.updateEventType(REQ, introId, { bookingWindowDays: 731 }))).message).toMatch(/730/);
      expect((await crud.getEventType(REQ, introId)).bookingWindowDays).toBeNull();
    });

    it('is listed on /v2 event types in cal.com\'s shape, calendar days, not rolling', async () => {
      await crud.updateEventType(REQ, introId, { bookingWindowDays: 21 });
      const calendar = new CalendarEffects(new DisabledCalendarProvider(), db);
      const pilot = new CalV2PilotService(db, calendar, bookings, new CalV2Service(bookings, db));
      const rows = await pilot.eventTypes(accountId, {});
      expect(rows.find((r) => r.slug === 'intro-call')?.bookingWindow).toEqual({ type: 'calendarDays', value: 21, rolling: false });
      expect(rows.find((r) => r.slug === 'team-demo')?.bookingWindow).toBeNull();
    });
  });

  describe('enforcement on the public REST surface', () => {
    it('slots stop at the last day of the window, personal and team, and only once it is set', async () => {
      const last = lastWindowDay();
      expect((await personalSlots()).some((s) => hostDay(s.startUtc) > last)).toBe(true);
      expect((await teamSlots()).some((s) => hostDay(s.startUtc) > last)).toBe(true);
      await crud.updateEventType(REQ, introId, { bookingWindowDays: WINDOW_DAYS });
      await crud.updateEventType(REQ, teamEventId, { bookingWindowDays: WINDOW_DAYS });
      const personal = await personalSlots();
      const team = await teamSlots();
      expect(personal.length).toBeGreaterThan(0);
      expect(team.length).toBeGreaterThan(0);
      expect(personal.filter((s) => hostDay(s.startUtc) > last)).toEqual([]);
      expect(team.filter((s) => hostDay(s.startUtc) > last)).toEqual([]);
    });

    it('a public booking, a hold and a team booking past the window answer what a time not offered answers', async () => {
      const last = lastWindowDay();
      const [past, past2] = (await personalSlots()).filter((s) => hostDay(s.startUtc) > last);
      const teamPast = (await teamSlots()).find((s) => hostDay(s.startUtc) > last)!;
      await crud.updateEventType(REQ, introId, { bookingWindowDays: WINDOW_DAYS });
      await crud.updateEventType(REQ, teamEventId, { bookingWindowDays: WINDOW_DAYS });
      // 03:13 in New York, tomorrow: inside the window, outside the hours.
      const [y, m, d] = hostDay(Date.now()).split('-').map(Number);
      const unoffered = new Date(Date.UTC(y!, m! - 1, d! + 1, 7, 13)).toISOString();

      const book = (startUtc: string, email: string) =>
        bookings.book({ accountCode: 'acme', handle: 'alex-rivera', slug: 'intro-call', startUtc, attendee: attendee(email), answers: { company: 'Example Co' } });
      const refusedPast = await book(past!.startUtc, 'past@example.org');
      const refusedUnoffered = await book(unoffered, 'unoffered@example.org');
      expect(refusedPast).toMatchObject({ error: (refusedUnoffered as { error: string }).error, status: (refusedUnoffered as { status: number }).status });

      const hold = (startUtc: string) => bookings.reserve({ accountCode: 'acme', handle: 'alex-rivera', slug: 'intro-call', startUtc });
      const holdPast = await hold(past2!.startUtc);
      const holdUnoffered = await hold(unoffered);
      expect('error' in holdPast).toBe(true);
      expect(holdPast).toMatchObject({ error: (holdUnoffered as { error: string }).error });

      const teamBook = (startUtc: string, email: string) =>
        bookings.teamBook('acme', 'sales', { slug: 'team-demo', startUtc, attendee: attendee(email) });
      const teamRefused = await teamBook(teamPast.startUtc, 'team-past@example.org');
      const teamUnoffered = await teamBook(unoffered, 'team-unoffered@example.org');
      expect('error' in teamRefused).toBe(true);
      expect(teamRefused).toMatchObject({ error: (teamUnoffered as { error: string }).error });
      expect(refusedPast).toMatchObject({ message: 'That time is not available.' });
      for (const at of [past!.startUtc, teamPast.startUtc]) {
        const n = await db.get<{ n: number | string }>(sql`SELECT COUNT(*) AS n FROM booking WHERE start_ms = ${new Date(at).getTime()}`);
        expect(Number(n!.n)).toBe(0);
      }
    });

    it('a reschedule through the manage link cannot move a booking past the window', async () => {
      const last = lastWindowDay();
      const all = await personalSlots();
      const inside = all.find((s) => hostDay(s.startUtc) <= last)!;
      const past = all.find((s) => hostDay(s.startUtc) > last)!;
      const made = await bookings.book({
        accountCode: 'acme',
        handle: 'alex-rivera',
        slug: 'intro-call',
        startUtc: inside.startUtc,
        attendee: attendee('mover@example.org'),
        answers: { company: 'Example Co' },
      });
      if ('error' in made) throw new Error(`book failed: ${made.error}`);
      await crud.updateEventType(REQ, introId, { bookingWindowDays: WINDOW_DAYS });
      const token = new URL(made.manageUrl!).searchParams.get('token')!;
      const moved = await bookings.reschedule(made.uid, { token, newStartUtc: past.startUtc });
      expect('error' in moved).toBe(true);
      // The picker offers nothing past the window either.
      const picker = await bookings.rescheduleAvailability(made.uid, token, window());
      expect(picker!.slots.filter((s) => hostDay(s.startUtc) > last)).toEqual([]);
    });

    it('a host booking on their own behalf ("any time") is not limited, exactly like the minimum notice', async () => {
      const past = (await personalSlots()).filter((s) => hostDay(s.startUtc) > lastWindowDay()).at(-1)!;
      await crud.updateEventType(REQ, introId, { bookingWindowDays: WINDOW_DAYS });
      const out = await createBooking(db, {
        accountCode: 'acme',
        handle: 'alex-rivera',
        slug: 'intro-call',
        startMs: new Date(past.startUtc).getTime(),
        attendee: attendee('host-made@example.org'),
        answers: { company: 'Example Co' },
        onBehalf: true,
      });
      expect(out.ok).toBe(true);
    });
  });
});
