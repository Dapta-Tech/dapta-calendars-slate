import { describe, it, expect, beforeEach } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { createDb, createSchedule, migrate, seed, sql, type Db } from '@slate/db';
import { DisabledCalendarProvider } from '@slate/calendar';
import { loadServerEnv } from '@slate/config/env';
import { BookingNotifier, NoopEmailProvider } from '@slate/notifications';
import { AdminCrudController } from './admin-crud.controller';
import type { AuthService, HostPrincipal, ReqLike } from './auth.service';
import { BookingService } from './booking.service';
import { CalendarEffects } from './calendar-effects';
import { EmailEffects } from './email-effects';

const ENV = loadServerEnv({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);
const REQ: ReqLike = { headers: {} };
const DAY = 86_400_000;
/** The seed host's zone. */
const HOST_TZ = 'America/New_York';
const TUESDAY_MORNING = { timeZone: HOST_TZ, ranges: [{ days: [2], start: '10:00', end: '12:00' }] };

async function refusalOf(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (err) {
    expect(err).toBeInstanceOf(BadRequestException);
    return ((err as BadRequestException).getResponse() as { message: string }).message;
  }
  throw new Error('expected the save to be refused');
}

/** Weekday (0=Sun) and "HH:MM" of an instant in the host's zone. */
function hostClock(iso: string): { weekday: number; time: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: HOST_TZ,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return {
    weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday')),
    time: `${get('hour')}:${get('minute')}`,
  };
}

/**
 * Custom hours on the event-type API: the save rules (one source at a time,
 * personal events only, valid ranges), what a read returns, that the private
 * schedule never shows through the schedules API, and that the public booking
 * page offers exactly those hours. The MCP slot tool has its own spec
 * (`mcp/mcp.custom-hours.spec.ts`).
 */
describe('custom hours on event types', () => {
  let db: Db;
  let crud: AdminCrudController;
  let bookings: BookingService;
  let introId: string;
  let teamEventId: string;

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    const m = (await db.get<{ id: string; account_id: string }>(
      sql`SELECT id, account_id FROM member WHERE handle='alex-rivera'`,
    ))!;
    const principal: HostPrincipal = { accountId: m.account_id, memberId: m.id, role: 'owner' };
    crud = new AdminCrudController(db, { resolveHost: () => Promise.resolve(principal) } as unknown as AuthService);
    const calendar = new CalendarEffects(new DisabledCalendarProvider(), db);
    bookings = new BookingService(db, ENV, calendar, new EmailEffects(new BookingNotifier(new NoopEmailProvider()), db));
    introId = (await db.get<{ id: string }>(sql`SELECT id FROM event_type WHERE slug='intro-call'`))!.id;
    teamEventId = (await db.get<{ id: string }>(sql`SELECT id FROM event_type WHERE slug='team-demo'`))!.id;
  });

  const ownedScheduleId = async () =>
    (await db.get<{ s: string }>(sql`SELECT schedule_id AS s FROM event_type WHERE id = ${introId}`))!.s;

  describe('the save', () => {
    it('stores custom hours, reads them back, and hides the schedule id', async () => {
      const saved = await crud.updateEventType(REQ, introId, { customHours: TUESDAY_MORNING });
      expect(saved.customHours).toEqual(TUESDAY_MORNING);
      expect(saved.scheduleId).toBeNull();
      expect((await crud.getEventType(REQ, introId)).customHours).toEqual(TUESDAY_MORNING);
    });

    it('creates an event with custom hours', async () => {
      const created = await crud.createEventType(REQ, {
        slug: 'office-hours',
        title: 'Office hours',
        lengthMinutes: 30,
        customHours: TUESDAY_MORNING,
      });
      expect(created.customHours).toEqual(TUESDAY_MORNING);
    });

    it('leaves the source alone when customHours is omitted, and clears it with null', async () => {
      await crud.updateEventType(REQ, introId, { customHours: TUESDAY_MORNING });
      expect((await crud.updateEventType(REQ, introId, { title: 'Renamed' })).customHours).toEqual(TUESDAY_MORNING);
      const cleared = await crud.updateEventType(REQ, introId, { customHours: null, scheduleId: null });
      expect(cleared.customHours).toBeNull();
      expect(cleared.scheduleId).toBeNull();
    });

    it('refuses custom hours together with a schedule id', async () => {
      const msg = await refusalOf(crud.updateEventType(REQ, introId, { customHours: TUESDAY_MORNING, scheduleId: null }));
      expect(msg).toMatch(/not both/);
    });

    it('refuses custom hours on a team event, on create and on update', async () => {
      expect(await refusalOf(crud.updateEventType(REQ, teamEventId, { customHours: TUESDAY_MORNING }))).toMatch(
        /personal event types/,
      );
      const teamId = (await db.get<{ id: string }>(sql`SELECT id FROM team LIMIT 1`))!.id;
      expect(
        await refusalOf(
          crud.createEventType(REQ, { slug: 't2', title: 'T2', lengthMinutes: 30, teamId, customHours: TUESDAY_MORNING }),
        ),
      ).toMatch(/personal event types/);
    });

    it('refuses invalid ranges: none, end before start, overlap through a preset', async () => {
      expect(
        await refusalOf(crud.updateEventType(REQ, introId, { customHours: { timeZone: HOST_TZ, ranges: [] } })),
      ).toMatch(/at least one/);
      expect(
        await refusalOf(
          crud.updateEventType(REQ, introId, {
            customHours: { timeZone: HOST_TZ, ranges: [{ days: [1], start: '17:00', end: '09:00' }] },
          }),
        ),
      ).toMatch(/End must be after start/);
      expect(
        await refusalOf(
          crud.updateEventType(REQ, introId, {
            customHours: {
              timeZone: HOST_TZ,
              ranges: [
                { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' },
                { days: [1], start: '16:00', end: '18:00' },
              ],
            },
          }),
        ),
      ).toMatch(/overlap/);
    });

    it("refuses pointing an event at another event's custom hours", async () => {
      await crud.updateEventType(REQ, introId, { customHours: TUESDAY_MORNING });
      const other = await crud.createEventType(REQ, { slug: 'other', title: 'Other', lengthMinutes: 30 });
      expect(await refusalOf(crud.updateEventType(REQ, other.id, { scheduleId: await ownedScheduleId() }))).toMatch(
        /cannot be used/,
      );
    });
  });

  describe('which schedule an event may follow', () => {
    it("refuses another member's schedule and another account's", async () => {
      const jordan = (await db.get<{ id: string; account_id: string }>(sql`SELECT id, account_id FROM member WHERE email='jordan@example.com'`))!;
      const theirs = (await createSchedule(db, jordan.account_id, jordan.id, { name: 'Jordan hours', timeZone: 'UTC' })).id;
      expect(await refusalOf(crud.updateEventType(REQ, introId, { scheduleId: theirs }))).toMatch(/cannot be used/);
      await db.run(sql`INSERT INTO account (id, code, name, created_at) VALUES ('acct-other', 'othr01', 'Other', ${Date.now()})`);
      await db.run(sql`INSERT INTO schedule (id, account_id, member_id, name, time_zone, created_at) VALUES ('sched-foreign', 'acct-other', 'm-x', 'X', 'UTC', ${Date.now()})`);
      expect(await refusalOf(crud.updateEventType(REQ, introId, { scheduleId: 'sched-foreign' }))).toMatch(/cannot be used/);
    });

    it("accepts the host's own reusable schedule", async () => {
      const own = (await crud.listSchedules(REQ))[0]!.id;
      expect((await crud.updateEventType(REQ, introId, { scheduleId: own })).scheduleId).toBe(own);
    });
  });

  describe('the schedules API', () => {
    it('does not list, read or change custom hours', async () => {
      await crud.updateEventType(REQ, introId, { customHours: TUESDAY_MORNING });
      const owned = await ownedScheduleId();
      expect((await crud.listSchedules(REQ)).map((s) => s.id)).not.toContain(owned);
      await expect(crud.getSchedule(REQ, owned)).rejects.toBeInstanceOf(NotFoundException);
      await expect(crud.updateSchedule(REQ, owned, { name: 'Hijacked' })).rejects.toBeInstanceOf(NotFoundException);
      // Delete is idempotent (204) for anything it cannot see: the hours survive.
      await crud.deleteSchedule(REQ, owned);
      expect((await crud.getEventType(REQ, introId)).customHours).toEqual(TUESDAY_MORNING);
    });
  });

  describe('the public booking page', () => {
    it('offers slots only inside the custom hours', async () => {
      await crud.updateEventType(REQ, introId, { customHours: TUESDAY_MORNING });
      const from = new Date().toISOString();
      const to = new Date(Date.now() + 14 * DAY).toISOString();
      const slots = (await bookings.availability({ accountCode: 'acme', handle: 'alex-rivera', slug: 'intro-call', from, to }))!
        .slots;
      expect(slots.length).toBeGreaterThan(0);
      for (const s of slots) {
        const c = hostClock(s.startUtc);
        expect(c.weekday).toBe(2);
        expect(c.time >= '10:00' && c.time < '12:00').toBe(true);
      }
    });
  });
});
