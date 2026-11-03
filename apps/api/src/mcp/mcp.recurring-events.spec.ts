import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { InMemoryCalendarProvider, type CalendarProvider } from '@slate/calendar';
import { loadHostEventSeries, sql } from '@slate/db';
import type { HostPrincipal } from '../auth.service';
import { AdminService } from '../admin.service';
import { CalendarEffects } from '../calendar-effects';
import { OutboxWorker } from '../outbox.worker';
import { SeriesExtender } from '../series-extender';
import { bootHarness, errorText, idem, structured, type Harness } from './mcp-harness';

/**
 * Repeating host events through the MCP (ADR 0012), with Felipe's two
 * weeklies as the case: "Weekly Dapta Phone" every Wednesday 15:30-16:00 in
 * Bogota with four people and a video link, then "Avances de la plataforma"
 * right after it, checked first against everyone's calendars. One series on
 * the calendar, every date a dCal booking, changes by date or from a date on.
 */

const ALL = ['availability:read', 'bookings:read', 'bookings:write', 'bookings:cancel', 'event-types:read'];
const REF = 'cal-ext-owner';
const BOGOTA = 'America/Bogota';
const PEOPLE = ['fausto@example.com', 'cele@example.com', 'daniel@example.com', 'jonathan@example.com'];

type Series = { id: string; rule: string; weekdays: string[]; count: number | null; until: string | null; status: string; date: string | null; skipped_dates: string[]; start_time: string };
type Event = { uid: string; kind: string; title: string; start: string; start_utc: string; end_utc: string; status: string; meeting_url: string | null; series: Series | null };
type Created = {
  event: Event;
  series: Series | null;
  dates_scheduled: number;
  skipped_dates: { date: string; reason: string }[];
  attendees: string[];
  calendar: string;
  video: string;
  already_created: boolean;
};

let h: Harness;
let calendar: InMemoryCalendarProvider;
let worker: OutboxWorker;
let ownerId: string;

/** A Wednesday at least `weeks` weeks past the next two, as YYYY-MM-DD. */
function wednesday(weeks = 0): string {
  const d = new Date(Date.now() + 14 * 86_400_000);
  d.setUTCDate(d.getUTCDate() + ((3 - d.getUTCDay() + 7) % 7) + 7 * weeks);
  return d.toISOString().slice(0, 10);
}
/** 15:30 in Bogota (UTC-5, no DST) on that date, with its offset. */
const bogota = (date: string, time: string) => `${date}T${time}:00-05:00`;

async function call(name: string, args: Record<string, unknown>, scopes = ALL) {
  const c = await h.connect(await h.key(scopes));
  return c.callTool({ name, arguments: args });
}
const create = (args: Record<string, unknown>) => call('create_event', { time_zone: BOGOTA, ...args });

async function calendarRows() {
  return h.db.all<{ action: string; order_key: string | null; payload: string | null; status: string }>(
    sql`SELECT action, order_key, payload, status FROM outbox WHERE kind = 'calendar' ORDER BY created_at ASC, id ASC`,
  );
}

/** Run every queued calendar job as the worker would. */
async function drain(): Promise<void> {
  await new Promise((r) => setTimeout(r, 20)); // let fire-and-forget enqueues land
  await worker.drainOnce(Date.now() + 60_000);
}

beforeAll(async () => {
  h = await bootHarness({ MCP_WRITE_RATE_LIMIT_CAPACITY: '500', MCP_RATE_LIMIT_CAPACITY: '500' });
  calendar = new InMemoryCalendarProvider();
  calendar.declaredFeatures = { recurrence: true, attendeeFreeBusy: true };
  calendar.mintRooms = true;
  (h.app.get(CalendarEffects) as unknown as { calendar: CalendarProvider }).calendar = calendar;
  worker = h.app.get(OutboxWorker);
  ownerId = (await h.db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle = 'alex-rivera'`))!.id;
  await h.db.run(
    sql`INSERT INTO connected_calendar (id, account_id, member_id, provider, external_id, is_destination, check_conflicts, created_at)
        VALUES (${randomUUID()}, ${h.accountId}, ${ownerId}, 'external', ${REF}, 1, 1, ${Date.now()})`,
  );
});
afterAll(async () => {
  await h.close();
});
afterEach(() => {
  calendar.seedBusy(REF, []);
  calendar.declaredFeatures = { recurrence: true, attendeeFreeBusy: true };
});

describe('repeating events through create_event', () => {
  it('Felipe\'s weekly: checked first, one series on the calendar with one video link, every date a booking', async () => {
    const first = wednesday(0);
    // "Did you check everyone's schedule?": the next five Wednesdays, one calendar not shared.
    calendar.seedAttendeeBusy('daniel@example.com', [
      { startUtc: `${wednesday(1)}T20:00:00.000Z`, endUtc: `${wednesday(1)}T21:00:00.000Z` },
    ]);
    calendar.seedAttendeeBusy('jonathan@example.com', 'not_shared');
    const check = structured<{
      mode: string;
      people: { email: string; role: string; calendar: string; reason: string | null }[];
      times: { start: string; all_free: boolean; busy: string[]; unknown: string[] }[];
    }>(
      await call('check_attendee_availability', {
        attendees: PEOPLE,
        start: bogota(first, '15:30'),
        duration_minutes: 30,
        repeat: { frequency: 'weekly', count: 5 },
        time_zone: BOGOTA,
      }),
    );
    expect(check.mode).toBe('check');
    expect(check.people[0]).toMatchObject({ email: 'alex@example.com', role: 'host', calendar: 'visible' });
    expect(check.people.find((p) => p.email === 'jonathan@example.com')).toMatchObject({ calendar: 'unknown', reason: 'not_shared' });
    expect(check.times).toHaveLength(5);
    expect(check.times.map((t) => t.start.slice(0, 16))).toEqual([0, 1, 2, 3, 4].map((w) => `${wednesday(w)}T15:30`));
    expect(check.times[1]!.busy).toEqual(['daniel@example.com']);
    // Unknown is never free.
    expect(check.times.every((t) => t.unknown.includes('jonathan@example.com') && !t.all_free)).toBe(true);
    expect(calendar.attendeeReads.at(-1)).toMatchObject({ connectionRef: REF, emails: PEOPLE });

    // One credential for the create and its retry: keys are per credential.
    const felipe = await h.connect(await h.key(ALL));
    const phone = {
      title: 'Weekly Dapta Phone',
      start: bogota(first, '15:30'),
      duration_minutes: 30,
      attendees: PEOPLE,
      video_link: true,
      recurrence: { frequency: 'weekly' },
      time_zone: BOGOTA,
      idempotency_key: idem('weekly-phone-0001'),
    };
    const out = structured<Created>(await felipe.callTool({ name: 'create_event', arguments: phone }));
    expect(out.series).toMatchObject({
      rule: 'every Wednesday at 15:30 (America/Bogota), no end date',
      weekdays: ['wednesday'],
      count: null,
      until: null,
      status: 'active',
      date: first,
    });
    expect(out.event).toMatchObject({ kind: 'event', title: 'Weekly Dapta Phone', start_utc: `${first}T20:30:00.000Z`, end_utc: `${first}T21:00:00.000Z` });
    expect(out.dates_scheduled).toBe(26);
    expect(out).toMatchObject({ calendar: 'queued', video: 'pending', already_created: false, attendees: PEOPLE });
    // ONE calendar job for the whole series, ordered with the series' other changes.
    const rows = await calendarRows();
    expect(rows.filter((r) => r.status === 'pending')).toEqual([
      expect.objectContaining({ action: 'series-create', order_key: `series:${out.series!.id}` }),
    ]);

    await drain();
    expect(calendar.created).toHaveLength(1);
    expect(calendar.created[0]).toMatchObject({
      connectionRef: REF,
      title: 'Weekly Dapta Phone',
      startUtc: `${first}T20:30:00.000Z`,
      endUtc: `${first}T21:00:00.000Z`,
      timeZone: BOGOTA,
      attendeeEmails: ['alex@example.com', ...PEOPLE],
      requestConferenceLink: true,
      sendInvitations: true,
      recurrence: {
        rrule: 'FREQ=WEEKLY;INTERVAL=1;WKST=MO;BYDAY=WE',
        frequency: 'weekly',
        interval: 1,
        weekdays: ['wednesday'],
        count: null,
        untilDate: null,
        startDate: first,
        timeZone: BOGOTA,
        excludedStartsUtc: [],
      },
    });
    // The link is the series' own, on every date.
    const got = structured<{ booking: Event }>(await call('get_booking', { booking_uid: out.event.uid }));
    expect(got.booking.meeting_url).toBe('https://video.example/evt-1');
    expect(got.booking.series).toMatchObject({ id: out.series!.id, date: first });
    const list = structured<{ bookings: { uid: string; series_id: string | null; title: string | null }[] }>(
      await call('list_bookings', { time_zone: BOGOTA, from: first, to: wednesday(4), status: 'accepted' }),
    );
    const dates = list.bookings.filter((b) => b.series_id === out.series!.id);
    expect(dates.length).toBe(4);
    expect(dates.every((b) => b.title === 'Weekly Dapta Phone')).toBe(true);

    // A retry answers the same series; a key used with other arguments is refused.
    const again = structured<Created>(await felipe.callTool({ name: 'create_event', arguments: phone }));
    expect(again).toMatchObject({ already_created: true, video: 'ready', series: { id: out.series!.id } });
    expect(again.event.meeting_url).toBe('https://video.example/evt-1');
    expect(calendar.created).toHaveLength(1);
    expect(errorText(await felipe.callTool({ name: 'create_event', arguments: { ...phone, title: 'Other' } }))).toMatch(/IDEMPOTENCY_KEY_REUSED/);
    // The same key once used for a single event is refused for a series, and the other way round.
    const { recurrence: _r, ...single } = phone;
    expect(errorText(await felipe.callTool({ name: 'create_event', arguments: single }))).toMatch(/IDEMPOTENCY_KEY_REUSED/);

    // "Avances de la plataforma" right after it: adjacent, not overlapping.
    const avances = structured<Created>(
      await create({
        title: 'Avances de la plataforma',
        start: bogota(first, '16:00'),
        duration_minutes: 30,
        attendees: PEOPLE.slice(1),
        video_link: true,
        recurrence: { frequency: 'weekly', weekdays: ['wednesday'] },
        idempotency_key: idem('avances-0001'),
      }),
    );
    expect(avances.series!.rule).toBe('every Wednesday at 16:00 (America/Bogota), no end date');
    // Overlapping the Phone is another dCal booking: never double-booked.
    expect(
      errorText(await create({ title: 'Clash', start: bogota(wednesday(2), '15:45'), duration_minutes: 30, idempotency_key: idem('clash-0001') })),
    ).toMatch(/SLOT_TAKEN/);
  });

  it('reports conflicts by date, and leaves out the dates asked to skip, on the calendar too', async () => {
    const first = wednesday(0);
    const third = wednesday(2);
    calendar.seedBusy(REF, [{ startUtc: `${third}T11:00:00.000Z`, endUtc: `${third}T12:00:00.000Z` }]);
    const args = { title: 'Standup', start: bogota(first, '06:00'), duration_minutes: 15, recurrence: { frequency: 'weekly', count: 6 } };
    const refused = errorText(await create({ ...args, idempotency_key: idem('standup-0001') }));
    expect(refused).toMatch(/CONFLICT/);
    expect(refused).toContain(`on ${third}`);
    expect(refused).toMatch(/skip_conflicting_dates/);
    const out = structured<Created>(await create({ ...args, skip_conflicting_dates: true, idempotency_key: idem('standup-0002') }));
    expect(out.dates_scheduled).toBe(5);
    expect(out.skipped_dates).toEqual([expect.objectContaining({ date: third, reason: 'busy' })]);
    await drain();
    expect(calendar.created.at(-1)!.recurrence).toMatchObject({ count: 6, excludedStartsUtc: [`${third}T11:00:00.000Z`] });
  });

  it('refuses a series a calendar cannot hold, writing nothing (never one lone event)', async () => {
    calendar.declaredFeatures = { recurrence: false };
    const before = (await h.db.all(sql`SELECT id FROM host_event_series`)).length;
    const text = errorText(
      await create({ title: 'Nope', start: bogota(wednesday(0), '07:00'), duration_minutes: 30, recurrence: { frequency: 'daily', count: 3 }, idempotency_key: idem('nope-0001') }),
    );
    expect(text).toMatch(/RECURRENCE_UNSUPPORTED/);
    expect((await h.db.all(sql`SELECT id FROM host_event_series`)).length).toBe(before);
  });

  it('cancels one date, this and following, or the whole series: the calendar changes the same way', async () => {
    const out = structured<Created>(
      await create({ title: 'Office hours', start: bogota(wednesday(0), '09:00'), duration_minutes: 60, attendees: ['ana@example.com'], recurrence: { frequency: 'weekly', count: 8 }, idempotency_key: idem('office-0001') }),
    );
    await drain();
    const seriesId = out.series!.id;
    const eventId = (await loadHostEventSeries(h.db, seriesId))!.calendarEventId!;
    const dates = (
      structured<{ bookings: { uid: string; series_id: string | null; start_utc: string }[] }>(
        await call('list_bookings', { time_zone: BOGOTA, from: wednesday(0), to: wednesday(10), status: 'accepted', limit: 50 }),
      ).bookings
    ).filter((b) => b.series_id === seriesId);
    expect(dates).toHaveLength(8);

    // One date: only that occurrence, by its original start.
    structured(await call('cancel_booking', { booking_uid: dates[1]!.uid }));
    await drain();
    expect(calendar.deleted.at(-1)).toMatchObject({ connectionRef: REF, externalEventId: eventId, occurrenceStartUtc: dates[1]!.start_utc, sendInvitations: true });

    // This and following: the series ends the day before; the calendar's event is cut there.
    const cut = structured<{ cancelled_uids: string[]; series: Series }>(
      await call('cancel_booking', { booking_uid: dates[5]!.uid, scope: 'this_and_following' }),
    );
    expect(cut.cancelled_uids).toHaveLength(3);
    expect(cut.series.until).toBe(new Date(Date.parse(`${wednesday(5)}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10));
    await drain();
    expect(calendar.updated.at(-1)).toMatchObject({ externalEventId: eventId, recurrence: { count: null, untilDate: cut.series.until } });
    // The single cancelled date stays out of the series on the calendar.
    expect(calendar.updated.at(-1)!.recurrence!.excludedStartsUtc).toEqual([dates[1]!.start_utc]);

    // The whole series, from the dashboard: same code, so the calendar's event is deleted.
    const admin = h.app.get(AdminService);
    const res = await admin.hostCancel({ accountId: h.accountId, memberId: ownerId } as unknown as HostPrincipal, dates[0]!.uid, undefined, 'series');
    expect(res).toMatchObject({ ok: true, alreadyApplied: false });
    await drain();
    expect(calendar.deleted.at(-1)).toMatchObject({ externalEventId: eventId, sendInvitations: true });
    expect(calendar.deleted.at(-1)!.occurrenceStartUtc).toBeUndefined();
    expect((await loadHostEventSeries(h.db, seriesId))!.status).toBe('cancelled');

    // Scope on a booking that is not a series date is refused.
    const single = await h.newBooking();
    expect(errorText(await call('cancel_booking', { booking_uid: single, scope: 'series' }))).toMatch(/not a date of a repeating event/);
  });

  it('moves one date, or the whole series to a new time and weekday', async () => {
    const out = structured<Created>(
      await create({ title: 'Review', start: bogota(wednesday(0), '11:00'), duration_minutes: 30, recurrence: { frequency: 'weekly', count: 4 }, idempotency_key: idem('review-0001') }),
    );
    await drain();
    const seriesId = out.series!.id;
    const eventId = (await loadHostEventSeries(h.db, seriesId))!.calendarEventId!;

    // One date, an hour later: that occurrence alone moves on the calendar.
    const one = structured<{ booking: Event; previous_uid: string }>(
      await call('reschedule_booking', { booking_uid: out.event.uid, start: bogota(wednesday(0), '12:00'), idempotency_key: idem('review-move-1') }),
    );
    await drain();
    expect(calendar.updated.at(-1)).toMatchObject({
      externalEventId: eventId,
      occurrenceStartUtc: out.event.start_utc,
      startUtc: `${wednesday(0)}T17:00:00.000Z`,
    });
    expect(one.booking.series).toMatchObject({ id: seriesId, date: wednesday(0) });

    // The whole series to Thursdays at 10:00: it has not started, so it moves in place.
    const moved = structured<{ booking: Event; series: Series; cancelled_uids: string[] }>(
      await call('reschedule_booking', {
        booking_uid: one.booking.uid,
        scope: 'series',
        start: bogota(new Date(Date.parse(`${wednesday(0)}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10), '10:00'),
        idempotency_key: idem('review-move-all'),
      }),
    );
    expect(moved.series).toMatchObject({ id: seriesId, weekdays: ['thursday'], start_time: '10:00', count: 4 });
    expect(moved.cancelled_uids).toHaveLength(4);
    await drain();
    expect(calendar.updated.at(-1)).toMatchObject({
      externalEventId: eventId,
      recurrence: { weekdays: ['thursday'], rrule: 'FREQ=WEEKLY;INTERVAL=1;WKST=MO;BYDAY=TH;COUNT=4' },
    });
    expect(calendar.updated.at(-1)!.occurrenceStartUtc).toBeUndefined();
  });

  it('finds times when everyone it can see is free, and names who it could not see', async () => {
    const day = wednesday(5);
    calendar.seedAttendeeBusy('busy@example.com', [{ startUtc: `${day}T13:00:00.000Z`, endUtc: `${day}T22:00:00.000Z` }]);
    calendar.seedAttendeeBusy('ghost@example.com', 'not_found');
    const out = structured<{ mode: string; times: { start: string; all_free: boolean; unknown: string[] }[]; people: { email: string; reason: string | null }[] }>(
      await call('check_attendee_availability', {
        attendees: ['busy@example.com', 'ghost@example.com'],
        duration_minutes: 30,
        from: day,
        to: day,
        time_zone: BOGOTA,
        max_results: 50,
      }),
    );
    expect(out.mode).toBe('find');
    // 08:00 to 18:00 in Bogota is 13:00 to 23:00 UTC; busy is busy until 22:00 UTC (17:00 there).
    expect(out.times.map((t) => t.start.slice(11, 16))).toEqual(['17:00', '17:30']);
    expect(out.times.every((t) => !t.all_free && t.unknown.includes('ghost@example.com'))).toBe(true);
    expect(out.people.find((p) => p.email === 'ghost@example.com')!.reason).toBe('not_found');

    // A connection that cannot read other calendars: every attendee unknown, never free.
    calendar.declaredFeatures = { recurrence: true, attendeeFreeBusy: false };
    const blind = structured<{ people: { email: string; calendar: string; reason: string | null }[] }>(
      await call('check_attendee_availability', { attendees: ['busy@example.com'], duration_minutes: 30, start: bogota(day, '08:00'), time_zone: BOGOTA }),
    );
    expect(blind.people[1]).toMatchObject({ calendar: 'unknown', reason: 'not_supported' });
  });

  it('the extension writes the new dates as time passes and cancels on the calendar one a booking took', async () => {
    const out = structured<Created>(
      await create({ title: 'Long run', start: bogota(wednesday(0), '19:00'), duration_minutes: 30, recurrence: { frequency: 'weekly' }, idempotency_key: idem('longrun-0001') }),
    );
    await drain();
    const series = (await loadHostEventSeries(h.db, out.series!.id))!;
    // Someone booked a date beyond the horizon before the series reached it.
    const WEEK = 7 * 86_400_000;
    const firstStart = Date.parse(out.event.start_utc);
    // The second date past the old horizon: written only once the horizon moves.
    const taken = firstStart + (Math.ceil((series.materializedUntilMs - firstStart) / WEEK) + 1) * WEEK;
    await h.db.run(
      sql`INSERT INTO booking (id, account_id, uid, event_type_id, host_member_id, title, start_ms, end_ms, status, created_at, updated_at)
          SELECT ${randomUUID()}, ${h.accountId}, ${randomUUID()}, id, ${ownerId}, 'Intro Call', ${taken}, ${taken + 3_600_000}, 'accepted', ${Date.now()}, ${Date.now()}
          FROM event_type WHERE slug = 'intro-call' LIMIT 1`,
    );
    const added = await h.app.get(SeriesExtender).runOnce(Date.now() + 30 * 86_400_000);
    expect(added).toBeGreaterThan(0);
    const after = (await loadHostEventSeries(h.db, out.series!.id))!;
    expect(after.materializedUntilMs).toBeGreaterThan(series.materializedUntilMs);
    expect(after.skipped).toEqual([expect.objectContaining({ startMs: taken, reason: 'booked' })]);
    await drain();
    expect(calendar.deleted.at(-1)).toMatchObject({ occurrenceStartUtc: new Date(taken).toISOString() });
  });
});
