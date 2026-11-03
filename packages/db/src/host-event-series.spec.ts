import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { InMemoryCalendarProvider, type BusyInterval, type CalendarProvider, type CalendarSummary, type ConnectionHealth, type CreatedEvent } from '@slate/calendar';
import type { RecurrenceRule, SeriesAnchor } from '@slate/engine';
import { createDb, type Db } from './client';
import { migrate } from './migrate';
import { seed } from './seed';
import {
  cancelHostEventSeries,
  createHostEventSeries,
  extendHostEventSeries,
  firstOccurrence,
  listSeriesDueForExtension,
  loadHostEventSeries,
  loadSeriesOccurrences,
  moveHostEventSeries,
  seriesOfBooking,
  SERIES_HORIZON_MS,
  type CreateHostEventSeriesArgs,
} from './host-event-series';
import { hostEventOwnTime, isHostEvent } from './host-event';
import { parseJsonColumn } from './repository';
import { rescheduleBookingV2 } from './v2-pilot';

class FailingCalendarProvider implements CalendarProvider {
  readonly enabled = true;
  listBusy(): Promise<BusyInterval[]> {
    return Promise.reject(new Error('backend 503'));
  }
  createEvent(): Promise<CreatedEvent> {
    return Promise.reject(new Error('backend 503'));
  }
  updateEvent(): Promise<CreatedEvent> {
    return Promise.reject(new Error('backend 503'));
  }
  deleteEvent(): Promise<void> {
    return Promise.reject(new Error('backend 503'));
  }
  listCalendars(): Promise<CalendarSummary[]> {
    return Promise.resolve([]);
  }
  checkConnection(): Promise<ConnectionHealth> {
    return Promise.resolve({ ok: false, detail: 'down' });
  }
}

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const REF = 'cal-ext-host';
const TZ = 'America/New_York';

/** A Sunday at least two weeks out, as YYYY-MM-DD in New York. */
function aSundayAhead(): string {
  const d = new Date(Date.now() + 14 * DAY);
  d.setUTCDate(d.getUTCDate() + ((7 - d.getUTCDay()) % 7));
  return d.toISOString().slice(0, 10);
}

/**
 * Repeating host events (ADR 0012): one series row, its dates written as
 * host-event bookings over a rolling horizon, each date checked like a single
 * event, and changes from one date on.
 */
describe('host event series (SQLite)', () => {
  let db: Db;
  let accountId: string;
  let memberId: string;
  let eventTypeId: string;
  let anchor: SeriesAnchor;
  const weekly: RecurrenceRule = { frequency: 'weekly', interval: 1, weekdays: ['sunday'], count: null, untilDate: null };

  const args = (over: Partial<CreateHostEventSeriesArgs> = {}): CreateHostEventSeriesArgs => ({
    accountId,
    memberId,
    title: 'Weekly Phone',
    attendees: ['fausto@example.com', 'cele@example.com'],
    anchor,
    rule: weekly,
    ...over,
  });

  async function connectCalendar(): Promise<void> {
    await db.run(
      sql`INSERT INTO connected_calendar
            (id, account_id, member_id, provider, external_id, is_destination, check_conflicts, created_at)
          VALUES (${randomUUID()}, ${accountId}, ${memberId}, ${'external'}, ${REF}, 1, 1, ${Date.now()})`,
    );
  }

  async function insertBooking(startMs: number, endMs: number): Promise<string> {
    const uid = randomUUID();
    await db.run(
      sql`INSERT INTO booking (id, account_id, uid, event_type_id, host_member_id, title, start_ms, end_ms, status, created_at, updated_at)
          VALUES (${randomUUID()}, ${accountId}, ${uid}, ${eventTypeId}, ${memberId}, 'Intro Call with Sam', ${startMs}, ${endMs}, 'accepted', ${Date.now()}, ${Date.now()})`,
    );
    return uid;
  }

  const ok = <T extends { ok: boolean }>(out: T) => {
    expect(out.ok).toBe(true);
    return out as Extract<T, { ok: true }>;
  };

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code = 'acme'`))!.id;
    memberId = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle = 'alex-rivera'`))!.id;
    eventTypeId = (await db.get<{ id: string }>(sql`SELECT id FROM event_type WHERE slug = 'intro-call'`))!.id;
    // 03:00 on Sundays in New York: outside every hour the seed offers.
    anchor = { startDate: aSundayAhead(), startTime: '03:00', durationMinutes: 30, timeZone: TZ };
  });

  it('writes one series and its dates over the horizon, each a host event linked to it', async () => {
    const out = ok(await createHostEventSeries(db, args({ description: 'Agenda', videoLink: true })));
    const series = (await loadHostEventSeries(db, out.seriesId))!;
    expect(series).toMatchObject({
      title: 'Weekly Phone',
      description: 'Agenda',
      locationKind: 'conferencing',
      status: 'active',
      attendees: ['fausto@example.com', 'cele@example.com'],
      calendarState: 'not_connected',
      rule: weekly,
      anchor,
    });
    const rows = await loadSeriesOccurrences(db, out.seriesId);
    expect(rows.length).toBe(out.occurrences);
    // Weekly over 180 days from the first date: 26 dates, all a week apart, the first one first.
    expect(rows.length).toBe(Math.ceil(SERIES_HORIZON_MS / WEEK));
    expect(rows[0]!.uid).toBe(out.firstUid);
    expect(rows[0]!.startMs).toBe(firstOccurrence(series).startMs);
    for (const [i, r] of rows.entries()) {
      expect(r.endMs - r.startMs).toBe(30 * 60_000);
      if (i > 0) expect(r.occurrenceStartMs - rows[i - 1]!.occurrenceStartMs).toBeGreaterThanOrEqual(WEEK - 3_600_000);
      expect(await isHostEvent(db, r.uid)).toBe(true);
    }
    const first = await db.get<Record<string, unknown>>(sql`SELECT * FROM booking WHERE uid = ${out.firstUid}`);
    expect(first).toMatchObject({ event_type_id: null, recurring_event_id: out.seriesId, title: 'Weekly Phone', calendar_description: 'Agenda', location_kind: 'conferencing', seated: 1 });
    expect(parseJsonColumn<{ _series: unknown }>(first!['metadata'], { _series: null })._series).toEqual({
      id: out.seriesId,
      occurrenceStartMs: rows[0]!.startMs,
    });
    const people = await db.all<{ email: string }>(sql`SELECT email FROM booking_attendee WHERE booking_id = ${first!['id'] as string} ORDER BY created_at`);
    expect(people.map((p) => p.email)).toEqual(['fausto@example.com', 'cele@example.com']);
    expect((await seriesOfBooking(db, out.firstUid, accountId))?.series.id).toBe(out.seriesId);
  });

  it('a counted series writes only its count; a dated one stops at its last date', async () => {
    const counted = ok(await createHostEventSeries(db, args({ rule: { ...weekly, count: 3 } })));
    expect(counted.occurrences).toBe(3);
    const lastDate = new Date(Date.parse(`${anchor.startDate}T12:00:00Z`) + 14 * DAY).toISOString().slice(0, 10);
    const dated = ok(
      await createHostEventSeries(db, args({ anchor: { ...anchor, startTime: '05:00' }, rule: { ...weekly, untilDate: lastDate } })),
    );
    expect(dated.occurrences).toBe(3);
  });

  it('never overlaps a dCal booking: refuses naming the date, or skips it when asked', async () => {
    const series = { anchor, rule: weekly };
    const third = firstOccurrence(series).startMs + 2 * WEEK;
    await insertBooking(third, third + 3_600_000);
    const refused = await createHostEventSeries(db, args());
    expect(refused).toMatchObject({ ok: false, reason: 'SLOT_TAKEN' });
    const conflicts = (refused as { conflicts: Array<{ kind: string; date: string }> }).conflicts;
    expect(conflicts[0]).toMatchObject({ kind: 'booking' });
    expect(conflicts[0]!.date).toBe(new Date(third).toLocaleDateString('en-CA', { timeZone: TZ }));
    // allow_conflicts does not change that.
    expect(await createHostEventSeries(db, args({ allowConflicts: true }))).toMatchObject({ ok: false, reason: 'SLOT_TAKEN' });
    const skipped = ok(await createHostEventSeries(db, args({ skipConflictingDates: true })));
    expect(skipped.skipped).toEqual([{ startMs: third, date: conflicts[0]!.date, reason: 'booked' }]);
    const rows = await loadSeriesOccurrences(db, skipped.seriesId);
    expect(rows.some((r) => r.occurrenceStartMs === third)).toBe(false);
    expect((await loadHostEventSeries(db, skipped.seriesId))!.skipped).toHaveLength(1);
  });

  it('busy time on the calendar: CONFLICT by date, written over with allow_conflicts, or skipped', async () => {
    await connectCalendar();
    const cal = new InMemoryCalendarProvider();
    const second = firstOccurrence({ anchor, rule: weekly }).startMs + WEEK;
    cal.seedBusy(REF, [{ startUtc: new Date(second).toISOString(), endUtc: new Date(second + 3_600_000).toISOString() }]);
    const refused = await createHostEventSeries(db, args(), cal);
    expect(refused).toMatchObject({ ok: false, reason: 'CONFLICT', conflicts: [{ kind: 'calendar', startMs: second }] });
    const over = ok(await createHostEventSeries(db, args({ allowConflicts: true }), cal));
    expect(over.overridden).toMatchObject([{ kind: 'calendar', startMs: second }]);
    const second2 = await db.get<{ metadata: unknown }>(
      sql`SELECT metadata FROM booking WHERE recurring_event_id = ${over.seriesId} AND start_ms = ${second}`,
    );
    expect(parseJsonColumn<{ _hostEvent: { overridden: unknown[] } }>(second2!.metadata, { _hostEvent: { overridden: [] } })._hostEvent.overridden).toHaveLength(1);
    await cancelHostEventSeries(db, { accountId, uid: over.firstUid, scope: 'series' });
    const skipped = ok(await createHostEventSeries(db, args({ skipConflictingDates: true }), cal));
    expect(skipped.skipped).toMatchObject([{ startMs: second, reason: 'busy' }]);
  });

  it('an unreadable calendar refuses, unless conflicts are allowed (then unchecked)', async () => {
    await connectCalendar();
    expect(await createHostEventSeries(db, args(), new FailingCalendarProvider())).toMatchObject({ ok: false, reason: 'CALENDAR_UNAVAILABLE' });
    expect(await createHostEventSeries(db, args({ skipConflictingDates: true }), new FailingCalendarProvider())).toMatchObject({
      ok: false,
      reason: 'CALENDAR_UNAVAILABLE',
    });
    const out = ok(await createHostEventSeries(db, args({ allowConflicts: true }), new FailingCalendarProvider()));
    expect(out.calendarChecked).toBe(false);
  });

  it('a repeated key answers the same series; with other arguments it is refused', async () => {
    const a = ok(await createHostEventSeries(db, args({ idempotencyKey: 'k1', requestHash: 'h1' })));
    const b = ok(await createHostEventSeries(db, args({ idempotencyKey: 'k1', requestHash: 'h1' })));
    expect(b).toMatchObject({ replayed: true, seriesId: a.seriesId, firstUid: a.firstUid, occurrences: a.occurrences });
    expect(await createHostEventSeries(db, args({ idempotencyKey: 'k1', requestHash: 'h2' }))).toEqual({ ok: false, reason: 'IDEMPOTENCY_KEY_REUSED' });
    expect((await db.all(sql`SELECT id FROM host_event_series`)).length).toBe(1);
  });

  it('validates the rule and the dates', async () => {
    expect(await createHostEventSeries(db, args({ rule: { ...weekly, weekdays: ['monday'] } }))).toMatchObject({ ok: false, reason: 'INVALID' });
    expect(await createHostEventSeries(db, args({ rule: { ...weekly, count: 400 } }))).toMatchObject({ ok: false, reason: 'INVALID' });
    expect(await createHostEventSeries(db, args({ anchor: { ...anchor, durationMinutes: 2 } }))).toMatchObject({ ok: false, reason: 'INVALID' });
    expect(await createHostEventSeries(db, args({ anchor: { ...anchor, startDate: '2020-01-05' } }))).toMatchObject({ ok: false, reason: 'INVALID' });
    expect(await createHostEventSeries(db, args({ memberId: 'nobody' }))).toEqual({ ok: false, reason: 'NOT_FOUND' });
  });

  it('the extension writes the dates that come within the horizon, once, and skips one a booking took', async () => {
    const out = ok(await createHostEventSeries(db, args()));
    const before = (await loadSeriesOccurrences(db, out.seriesId)).length;
    const series = (await loadHostEventSeries(db, out.seriesId))!;
    // A month later, the horizon is behind; a booking sits on one of the new dates.
    const later = Date.now() + 30 * DAY;
    expect(await listSeriesDueForExtension(db, later)).toContain(out.seriesId);
    const newDates = (await import('./host-event-series')).seriesDates(series, series.materializedUntilMs, later + SERIES_HORIZON_MS);
    const taken = newDates[1]!.startMs;
    await insertBooking(taken, taken + 3_600_000);
    const ext = (await extendHostEventSeries(db, out.seriesId, later))!;
    expect(ext.added).toBe(newDates.length - 1);
    expect(ext.skipped).toMatchObject([{ startMs: taken, reason: 'booked' }]);
    expect((await loadSeriesOccurrences(db, out.seriesId)).length).toBe(before + newDates.length - 1);
    // Twice, or from two replicas: nothing more.
    expect(await extendHostEventSeries(db, out.seriesId, later)).toMatchObject({ added: 0 });
    expect(await listSeriesDueForExtension(db, later)).not.toContain(out.seriesId);
  });

  it('a counted series ends once every date is written', async () => {
    const out = ok(await createHostEventSeries(db, args({ rule: { ...weekly, count: 2 } })));
    const ext = (await extendHostEventSeries(db, out.seriesId, Date.now() + 40 * DAY))!;
    expect(ext).toMatchObject({ added: 0, ended: true });
    expect((await loadHostEventSeries(db, out.seriesId))!.status).toBe('ended');
  });

  it('cancels this and following: the dates from there, the rule ended before it', async () => {
    const out = ok(await createHostEventSeries(db, args({ calendarQueued: true, calendarDestination: REF })));
    const rows = await loadSeriesOccurrences(db, out.seriesId);
    const third = rows[2]!;
    const res = ok(await cancelHostEventSeries(db, { accountId, uid: third.uid, scope: 'this_and_following', reason: 'Done' }));
    expect(res).toMatchObject({ calendar: 'trim', alreadyApplied: false });
    expect(res.cancelled).toHaveLength(rows.length - 2);
    const after = await loadSeriesOccurrences(db, out.seriesId);
    expect(after.filter((r) => r.status === 'accepted').map((r) => r.uid)).toEqual([rows[0]!.uid, rows[1]!.uid]);
    const series = (await loadHostEventSeries(db, out.seriesId))!;
    expect(series.rule.untilDate).toBe(new Date(third.occurrenceStartMs - DAY).toLocaleDateString('en-CA', { timeZone: TZ }));
    expect(series.status).toBe('ended');
    const again = ok(await cancelHostEventSeries(db, { accountId, uid: third.uid, scope: 'this_and_following' }));
    expect(again).toMatchObject({ alreadyApplied: true, calendar: 'none', cancelled: [] });
  });

  it('cancels a whole series that has not started: every date, and the calendar event is deleted', async () => {
    const out = ok(await createHostEventSeries(db, args({ calendarQueued: true, calendarDestination: REF })));
    const res = ok(await cancelHostEventSeries(db, { accountId, uid: out.firstUid, scope: 'series' }));
    expect(res.calendar).toBe('delete');
    expect((await loadSeriesOccurrences(db, out.seriesId)).every((r) => r.status === 'cancelled')).toBe(true);
    expect((await loadHostEventSeries(db, out.seriesId))!.status).toBe('cancelled');
    expect(await listSeriesDueForExtension(db, Date.now() + 60 * DAY)).not.toContain(out.seriesId);
    expect(await cancelHostEventSeries(db, { accountId, uid: 'nope', scope: 'series' })).toEqual({ ok: false, reason: 'NOT_FOUND' });
    const single = await insertBooking(Date.now() + 40 * DAY, Date.now() + 40 * DAY + 3_600_000);
    expect(await cancelHostEventSeries(db, { accountId, uid: single, scope: 'series' })).toEqual({ ok: false, reason: 'NOT_A_SERIES' });
  });

  it('moves a whole series that has not started in place, to a new time and weekday', async () => {
    const out = ok(await createHostEventSeries(db, args({ calendarQueued: true, calendarDestination: REF })));
    const first = (await loadSeriesOccurrences(db, out.seriesId))[0]!;
    // Sunday 03:00 to Monday 04:30, New York time.
    const target = first.startMs + DAY + 90 * 60_000;
    const moved = ok(await moveHostEventSeries(db, { accountId, uid: first.uid, scope: 'series', newStartMs: target }));
    expect(moved).toMatchObject({ seriesId: out.seriesId, previousSeriesId: null, alreadyApplied: false });
    const series = (await loadHostEventSeries(db, out.seriesId))!;
    expect(series.anchor.startTime).toBe('04:30');
    expect(series.rule.weekdays).toEqual(['monday']);
    const rows = await loadSeriesOccurrences(db, out.seriesId);
    expect(rows.filter((r) => r.status === 'cancelled').length).toBe(out.occurrences);
    const live = rows.filter((r) => r.status === 'accepted');
    expect(live[0]!.startMs).toBe(target);
    expect(live.every((r) => new Date(r.startMs).toLocaleString('en-US', { timeZone: TZ, weekday: 'long', hour: '2-digit', minute: '2-digit', hour12: false }).startsWith('Monday'))).toBe(true);
    // Retried: already there.
    expect(await moveHostEventSeries(db, { accountId, uid: live[0]!.uid, scope: 'series', newStartMs: target })).toMatchObject({ ok: true, alreadyApplied: true });
  });

  it('moves this and following by splitting: the old series ends before it, a new one continues', async () => {
    const out = ok(await createHostEventSeries(db, args({ rule: { ...weekly, count: 10 } })));
    const rows = await loadSeriesOccurrences(db, out.seriesId);
    const fourth = rows[3]!;
    const target = fourth.startMs + 60 * 60_000;
    const moved = ok(await moveHostEventSeries(db, { accountId, uid: fourth.uid, scope: 'this_and_following', newStartMs: target }));
    expect(moved.previousSeriesId).toBe(out.seriesId);
    expect(moved.seriesId).not.toBe(out.seriesId);
    const old = (await loadHostEventSeries(db, out.seriesId))!;
    expect(old.rule).toMatchObject({ count: null, untilDate: new Date(fourth.occurrenceStartMs - DAY).toLocaleDateString('en-CA', { timeZone: TZ }) });
    const child = (await loadHostEventSeries(db, moved.seriesId))!;
    expect(child).toMatchObject({ splitFrom: out.seriesId, rule: { count: 7 }, anchor: { startTime: '04:00' } });
    expect((await loadSeriesOccurrences(db, moved.seriesId)).length).toBe(7);
    expect((await loadSeriesOccurrences(db, out.seriesId)).filter((r) => r.status === 'accepted')).toHaveLength(3);
    const again = await moveHostEventSeries(db, { accountId, uid: rows[2]!.uid, scope: 'this_and_following', newStartMs: rows[2]!.startMs + 60 * 60_000 });
    expect(again.ok).toBe(true);
  });

  it('a move refuses a date a dCal booking holds, naming it', async () => {
    const out = ok(await createHostEventSeries(db, args({ rule: { ...weekly, count: 4 } })));
    const rows = await loadSeriesOccurrences(db, out.seriesId);
    const target = rows[0]!.startMs + 2 * 3_600_000;
    await insertBooking(rows[1]!.startMs + 2 * 3_600_000, rows[1]!.startMs + 3 * 3_600_000);
    expect(await moveHostEventSeries(db, { accountId, uid: rows[0]!.uid, scope: 'series', newStartMs: target })).toMatchObject({
      ok: false,
      reason: 'SLOT_TAKEN',
    });
    // Nothing changed.
    expect((await loadSeriesOccurrences(db, out.seriesId)).every((r) => r.status === 'accepted')).toBe(true);
  });

  it('one date moved on its own stays in its series, under its original date', async () => {
    const out = ok(await createHostEventSeries(db, args({ rule: { ...weekly, count: 3 } })));
    const second = (await loadSeriesOccurrences(db, out.seriesId))[1]!;
    const moved = await rescheduleBookingV2(db, { accountId, uid: second.uid, newStartMs: second.startMs + 2 * 3_600_000, idempotencyKey: 'mv-1' });
    expect(moved.ok).toBe(true);
    const newUid = (moved as { uid: string }).uid;
    const found = (await seriesOfBooking(db, newUid, accountId))!;
    expect(found.series.id).toBe(out.seriesId);
    expect(found.occurrence.occurrenceStartMs).toBe(second.startMs);
    expect(found.occurrence.startMs).toBe(second.startMs + 2 * 3_600_000);
  });

  it('a date of a series written to the calendar is the host\'s own time there', async () => {
    const out = ok(await createHostEventSeries(db, args({ rule: { ...weekly, count: 2 }, calendarQueued: true, calendarDestination: REF })));
    const row = (await db.get<{ id: string; event_type_id: string | null; start_ms: number; end_ms: number }>(
      sql`SELECT id, event_type_id, start_ms, end_ms FROM booking WHERE uid = ${out.firstUid}`,
    ))!;
    expect(await hostEventOwnTime(db, row)).toBeNull();
    await db.run(sql`UPDATE host_event_series SET calendar_event_id = 'evt-1' WHERE id = ${out.seriesId}`);
    expect(await hostEventOwnTime(db, row)).toEqual({ startMs: Number(row.start_ms), endMs: Number(row.end_ms) });
  });
});
