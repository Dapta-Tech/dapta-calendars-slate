import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  InMemoryCalendarProvider,
  type BusyInterval,
  type CalendarProvider,
  type CalendarSummary,
  type ConnectionHealth,
  type CreatedEvent,
} from '@slate/calendar';
import { createDb, type Db } from './client';
import { migrate } from './migrate';
import { seed } from './seed';
import { busyOutside, createHostEvent, hostEventAttendees, isHostEvent, type CreateHostEventArgs } from './host-event';
import { loadBusyForHost, parseJsonColumn } from './repository';
import { rescheduleBookingV2 } from './v2-pilot';
import { rescheduleBooking } from './parity';
import { loadBookingForCalendarWrite } from './calendar-refs';

/** Enabled provider whose busy read always fails (an outage, a revoked grant). */
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
    return Promise.resolve({ ok: false, detail: 'Reauthorization required' });
  }
}

const HOUR = 3_600_000;
const REF = 'cal-ext-host';

/**
 * Host events (`createHostEvent`): a host's own event, stored as a booking with
 * no event type. Any time and length; the host's dCal bookings are never
 * overlapped; busy time on the connected calendar and other callers' holds
 * are refused unless the host says to ignore them.
 */
describe('createHostEvent (SQLite)', () => {
  let db: Db;
  let accountId: string;
  let memberId: string;
  let eventTypeId: string;
  /** A Sunday at 03:00 New York time, three weeks out: outside every hour the seed offers. */
  let offHours: number;

  const args = (over: Partial<CreateHostEventArgs> = {}): CreateHostEventArgs => ({
    accountId,
    memberId,
    title: 'Study Dapti',
    startMs: offHours,
    endMs: offHours + 4 * HOUR,
    attendees: [],
    timeZone: 'America/New_York',
    ...over,
  });

  async function connectCalendar(): Promise<void> {
    await db.run(
      sql`INSERT INTO connected_calendar
            (id, account_id, member_id, provider, external_id, is_destination, check_conflicts, created_at)
          VALUES (${randomUUID()}, ${accountId}, ${memberId}, ${'external'}, ${REF}, 1, 1, ${Date.now()})`,
    );
  }

  async function insertBooking(startMs: number, endMs: number, status = 'accepted'): Promise<string> {
    const uid = randomUUID();
    await db.run(
      sql`INSERT INTO booking (id, account_id, uid, event_type_id, host_member_id, title, start_ms, end_ms, status, created_at, updated_at)
          VALUES (${randomUUID()}, ${accountId}, ${uid}, ${eventTypeId}, ${memberId}, 'Intro Call with Sam', ${startMs}, ${endMs}, ${status}, ${Date.now()}, ${Date.now()})`,
    );
    return uid;
  }

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code = 'acme'`))!.id;
    memberId = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle = 'alex-rivera'`))!.id;
    eventTypeId = (await db.get<{ id: string }>(sql`SELECT id FROM event_type WHERE slug = 'intro-call'`))!.id;
    // Next Sunday 08:00 UTC (03:00 or 04:00 in New York), at least two weeks out.
    const d = new Date(Date.now() + 14 * 86_400_000);
    d.setUTCHours(8, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() + ((7 - d.getUTCDay()) % 7));
    offHours = d.getTime();
  });

  it('stores a booking with no event type, its own title and body, any time and length, seated', async () => {
    const out = await createHostEvent(db, args({ description: 'Chapter 3' }));
    expect(out).toMatchObject({ ok: true, replayed: false, overridden: [], calendarChecked: true });
    const uid = (out as { uid: string }).uid;
    const row = await db.get<Record<string, unknown>>(sql`SELECT * FROM booking WHERE uid = ${uid}`);
    expect(row).toMatchObject({
      account_id: accountId,
      event_type_id: null,
      host_member_id: memberId,
      title: 'Study Dapti',
      calendar_description: 'Chapter 3',
      location: null,
      location_kind: 'custom',
      status: 'accepted',
      attendee_time_zone: 'America/New_York',
      seated: 1,
    });
    expect(Number(row!['start_ms'])).toBe(offHours);
    expect(Number(row!['end_ms'])).toBe(offHours + 4 * HOUR);
    expect(parseJsonColumn<Record<string, unknown>>(row!['metadata'], {})).not.toHaveProperty('_manage');
    expect(await isHostEvent(db, uid)).toBe(true);
    expect(await db.all(sql`SELECT id FROM booking_attendee WHERE booking_id = ${row!['id'] as string}`)).toHaveLength(0);
  });

  it('asks for a video link only when told to', async () => {
    const out = await createHostEvent(db, args({ title: '1:1', videoLink: true, attendees: ['dan@example.com'] }));
    const uid = (out as { uid: string }).uid;
    const row = await db.get<{ location_kind: string; location: string | null }>(sql`SELECT location_kind, location FROM booking WHERE uid = ${uid}`);
    expect(row).toEqual({ location_kind: 'conferencing', location: null });
  });

  it('keeps each attendee once, in order, without the host, and writes them for the calendar', async () => {
    expect(hostEventAttendees(['A@x.co', 'a@x.co', 'alex@example.com', ' b@x.co '], 'Alex@Example.com')).toEqual(['A@x.co', 'b@x.co']);
    await connectCalendar();
    const out = await createHostEvent(
      db,
      args({ title: 'Phone', attendees: ['fausto@example.com', 'dan@example.com', 'FAUSTO@example.com', 'alex@example.com', 'cele@example.com'] }),
      new InMemoryCalendarProvider(),
    );
    const uid = (out as { uid: string }).uid;
    const ctx = await loadBookingForCalendarWrite(db, uid);
    // The calendar event: the host first, then each attendee once; the host's own calendar.
    expect(ctx!.attendeeEmails[0]).toBe('alex@example.com');
    expect([...ctx!.attendeeEmails].sort()).toEqual(['alex@example.com', 'cele@example.com', 'dan@example.com', 'fausto@example.com']);
    // Nobody here is emailed by dCal, so the calendar's invitation is everyone's.
    expect(ctx!.otherGuestCount).toBe(2);
    expect(ctx!.destinationRefs).toEqual([REF]);
    expect(ctx!.title).toBe('Phone');
    expect(ctx!.locationKind).toBe('custom');
  });

  it('never overlaps a dCal booking of the host, even when told to ignore conflicts', async () => {
    const taken = await insertBooking(offHours + HOUR, offHours + 2 * HOUR);
    for (const allowConflicts of [false, true]) {
      const out = await createHostEvent(db, args({ allowConflicts }));
      expect(out).toMatchObject({ ok: false, reason: 'SLOT_TAKEN' });
      const conflicts = (out as { conflicts: Array<Record<string, unknown>> }).conflicts;
      // Named by its event type, never by its own title (which names the invitee).
      expect(conflicts).toEqual([
        { kind: 'booking', uid: taken, title: 'Intro Call', status: 'accepted', startMs: offHours + HOUR, endMs: offHours + 2 * HOUR },
      ]);
    }
    expect(await db.get(sql`SELECT id FROM booking WHERE event_type_id IS NULL`)).toBeUndefined();
    // A pending request holds its time too; a cancelled booking does not.
    await db.run(sql`UPDATE booking SET status = 'pending' WHERE uid = ${taken}`);
    expect(await createHostEvent(db, args())).toMatchObject({ ok: false, reason: 'SLOT_TAKEN' });
    await db.run(sql`UPDATE booking SET status = 'cancelled' WHERE uid = ${taken}`);
    expect(await createHostEvent(db, args())).toMatchObject({ ok: true });
  });

  it('two host events of the same host cannot overlap either', async () => {
    expect(await createHostEvent(db, args())).toMatchObject({ ok: true });
    const again = await createHostEvent(db, args({ title: 'Other', startMs: offHours + HOUR, endMs: offHours + 2 * HOUR }));
    expect(again).toMatchObject({ ok: false, reason: 'SLOT_TAKEN' });
    expect((again as { conflicts: Array<{ title: string }> }).conflicts[0]!.title).toBe('Study Dapti');
  });

  it('lists busy time on the connected calendar and writes nothing, unless told to ignore it', async () => {
    await connectCalendar();
    const calendar = new InMemoryCalendarProvider();
    calendar.seedBusy(REF, [
      { startUtc: new Date(offHours + HOUR).toISOString(), endUtc: new Date(offHours + 2 * HOUR).toISOString() },
      { startUtc: new Date(offHours + 10 * HOUR).toISOString(), endUtc: new Date(offHours + 11 * HOUR).toISOString() },
    ]);
    const refused = await createHostEvent(db, args(), calendar);
    expect(refused).toEqual({
      ok: false,
      reason: 'CONFLICT',
      conflicts: [{ kind: 'calendar', startMs: offHours + HOUR, endMs: offHours + 2 * HOUR }],
    });
    expect(await db.get(sql`SELECT id FROM booking WHERE event_type_id IS NULL`)).toBeUndefined();
    const made = await createHostEvent(db, args({ allowConflicts: true }), calendar);
    expect(made).toMatchObject({
      ok: true,
      calendarChecked: true,
      overridden: [{ kind: 'calendar', startMs: offHours + HOUR, endMs: offHours + 2 * HOUR }],
    });
  });

  it('fails closed on an unreadable calendar, and with allowConflicts says it was unchecked', async () => {
    await connectCalendar();
    const failing = new FailingCalendarProvider();
    expect(await createHostEvent(db, args(), failing)).toEqual({ ok: false, reason: 'CALENDAR_UNAVAILABLE' });
    expect(await createHostEvent(db, args({ allowConflicts: true }), failing)).toMatchObject({ ok: true, calendarChecked: false });
  });

  it("refuses another caller's hold unless told to ignore it", async () => {
    await db.run(
      sql`INSERT INTO slot_reservation (id, uid, account_id, event_type_id, member_id, slot_start_ms, slot_end_ms, release_at_ms, created_at)
          VALUES (${randomUUID()}, ${randomUUID()}, ${accountId}, ${eventTypeId}, ${memberId}, ${offHours}, ${offHours + HOUR / 2}, ${Date.now() + 600_000}, ${Date.now()})`,
    );
    expect(await createHostEvent(db, args())).toEqual({
      ok: false,
      reason: 'CONFLICT',
      conflicts: [{ kind: 'hold', startMs: offHours, endMs: offHours + HOUR / 2 }],
    });
    expect(await createHostEvent(db, args({ allowConflicts: true }))).toMatchObject({
      ok: true,
      overridden: [{ kind: 'hold', startMs: offHours, endMs: offHours + HOUR / 2 }],
    });
  });

  it('a retry racing its first attempt with the same key gets the replay, never its own event as a conflict', async () => {
    await connectCalendar();
    const keyed = args({ idempotencyKey: 'race', requestHash: 'h', calendarQueued: true });
    const [a, b] = await Promise.all([
      createHostEvent(db, keyed, new InMemoryCalendarProvider()),
      createHostEvent(db, keyed, new InMemoryCalendarProvider()),
    ]);
    expect(a).toMatchObject({ ok: true });
    expect(b).toMatchObject({ ok: true, uid: (a as { uid: string }).uid });
    expect([(a as { replayed: boolean }).replayed, (b as { replayed: boolean }).replayed].sort()).toEqual([false, true]);
    expect(await db.all(sql`SELECT id FROM booking WHERE event_type_id IS NULL`)).toHaveLength(1);
  });

  it('a replay answers whether the calendar write was queued then, not what the calendar is now', async () => {
    const first = await createHostEvent(db, args({ idempotencyKey: 'cal', requestHash: 'h', calendarQueued: true }));
    expect(first).toMatchObject({ ok: true, calendarQueued: true });
    expect(await createHostEvent(db, args({ idempotencyKey: 'cal', requestHash: 'h', calendarQueued: false }))).toMatchObject({
      ok: true,
      replayed: true,
      calendarQueued: true,
    });
  });

  it('a replay answers the busy time the first call ignored and whether the calendar could be read', async () => {
    await connectCalendar();
    const calendar = new InMemoryCalendarProvider();
    calendar.seedBusy(REF, [{ startUtc: new Date(offHours + HOUR).toISOString(), endUtc: new Date(offHours + 2 * HOUR).toISOString() }]);
    const over = args({ allowConflicts: true, idempotencyKey: 'over', requestHash: 'h' });
    const first = await createHostEvent(db, over, calendar);
    const ignored = [{ kind: 'calendar', startMs: offHours + HOUR, endMs: offHours + 2 * HOUR }];
    expect(first).toMatchObject({ ok: true, replayed: false, overridden: ignored, calendarChecked: true });
    // The retry finds the calendar unreadable now: it still answers what was decided.
    expect(await createHostEvent(db, over, new FailingCalendarProvider())).toMatchObject({
      ok: true,
      replayed: true,
      overridden: ignored,
      calendarChecked: true,
    });

    const unchecked = args({ allowConflicts: true, idempotencyKey: 'blind', requestHash: 'h', startMs: offHours + 6 * HOUR, endMs: offHours + 7 * HOUR });
    expect(await createHostEvent(db, unchecked, new FailingCalendarProvider())).toMatchObject({ ok: true, calendarChecked: false });
    expect(await createHostEvent(db, unchecked, new InMemoryCalendarProvider())).toMatchObject({
      ok: true,
      replayed: true,
      overridden: [],
      calendarChecked: false,
    });
  });

  it('replays a repeated key and refuses it with other arguments', async () => {
    const first = await createHostEvent(db, args({ idempotencyKey: 'k1', requestHash: 'h1' }));
    const again = await createHostEvent(db, args({ idempotencyKey: 'k1', requestHash: 'h1' }));
    expect(again).toMatchObject({ ok: true, replayed: true, uid: (first as { uid: string }).uid });
    expect(await createHostEvent(db, args({ idempotencyKey: 'k1', requestHash: 'h2', startMs: offHours + 8 * HOUR, endMs: offHours + 9 * HOUR })))
      .toEqual({ ok: false, reason: 'IDEMPOTENCY_KEY_REUSED' });
    expect(await db.all(sql`SELECT id FROM booking WHERE event_type_id IS NULL`)).toHaveLength(1);
  });

  it('acts only for an active member of the account, within sane bounds', async () => {
    expect(await createHostEvent(db, args({ accountId: randomUUID() }))).toEqual({ ok: false, reason: 'NOT_FOUND' });
    await db.run(sql`UPDATE member SET status = 'invited' WHERE id = ${memberId}`);
    expect(await createHostEvent(db, args())).toEqual({ ok: false, reason: 'NOT_FOUND' });
    await db.run(sql`UPDATE member SET status = 'active' WHERE id = ${memberId}`);
    expect(await createHostEvent(db, args({ title: '   ' }))).toMatchObject({ ok: false, reason: 'INVALID' });
    expect(await createHostEvent(db, args({ endMs: offHours + 60_000 }))).toMatchObject({ ok: false, reason: 'INVALID' });
    expect(await createHostEvent(db, args({ endMs: offHours + 25 * HOUR }))).toMatchObject({ ok: false, reason: 'INVALID' });
    expect(await createHostEvent(db, args({ startMs: Date.now() - 86_400_000, endMs: Date.now() - 82_800_000 }))).toMatchObject({
      ok: false,
      reason: 'INVALID',
    });
    const many = Array.from({ length: 11 }, (_, i) => `p${i}@example.com`);
    expect(await createHostEvent(db, args({ attendees: many }))).toMatchObject({ ok: false, reason: 'INVALID' });
  });

  it('counts as busy on a group event, whose own bookings do not', async () => {
    await createHostEvent(db, args());
    const busy = await loadBusyForHost(db, memberId, offHours, offHours + 4 * HOUR, eventTypeId);
    expect(busy.map((b) => b.start.getTime())).toEqual([offHours]);
  });
});

describe('rescheduleBookingV2 on a host event (SQLite)', () => {
  let db: Db;
  let accountId: string;
  let memberId: string;
  let start: number;

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code = 'acme'`))!.id;
    memberId = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle = 'alex-rivera'`))!.id;
    const d = new Date(Date.now() + 14 * 86_400_000);
    d.setUTCHours(8, 0, 0, 0);
    start = d.getTime();
    await db.run(
      sql`INSERT INTO connected_calendar
            (id, account_id, member_id, provider, external_id, is_destination, check_conflicts, created_at)
          VALUES (${randomUUID()}, ${accountId}, ${memberId}, ${'external'}, ${REF}, 1, 1, ${Date.now()})`,
    );
  });

  async function hostEvent(videoLink = false): Promise<string> {
    const out = await createHostEvent(db, {
      accountId,
      memberId,
      title: 'Study Dapti',
      startMs: start,
      endMs: start + 4 * HOUR,
      attendees: ['dan@example.com'],
      timeZone: 'America/New_York',
      videoLink,
    });
    return (out as { uid: string }).uid;
  }

  it('moves to any time, keeps its length, kind and title', async () => {
    const uid = await hostEvent();
    // 05:30 New York: no hours offer it, and a host event needs none.
    const to = start + 2.5 * HOUR;
    const out = await rescheduleBookingV2(db, { accountId, uid, newStartMs: to }, new InMemoryCalendarProvider());
    expect(out).toMatchObject({ ok: true, status: 'accepted' });
    const moved = await db.get<Record<string, unknown>>(sql`SELECT * FROM booking WHERE uid = ${(out as { uid: string }).uid}`);
    expect(moved).toMatchObject({ event_type_id: null, title: 'Study Dapti', location_kind: 'custom', rescheduled_from_uid: uid });
    expect(Number(moved!['end_ms']) - Number(moved!['start_ms'])).toBe(4 * HOUR);
  });

  it('carries the location kind, so a moved event asks for a video link exactly when it did', async () => {
    const uid = await hostEvent(true);
    const out = await rescheduleBookingV2(db, { accountId, uid, newStartMs: start + 24 * HOUR });
    const moved = await db.get<{ location_kind: string }>(sql`SELECT location_kind FROM booking WHERE uid = ${(out as { uid: string }).uid}`);
    expect(moved!.location_kind).toBe('conferencing');
  });

  /** The event's copy written on the calendar, as the write-out records it. */
  async function written(uid: string): Promise<void> {
    await db.run(
      sql`INSERT INTO booking_reference (id, booking_id, destination, type, external_event_id, created_at)
          SELECT ${randomUUID()}, id, ${REF}, 'calendar_event', ${`evt-${uid}`}, ${Date.now()} FROM booking WHERE uid = ${uid}`,
    );
  }

  it('does not read its own old time as busy once its copy is on the calendar, but still refuses other busy time', async () => {
    const uid = await hostEvent();
    await written(uid);
    const calendar = new InMemoryCalendarProvider();
    // The calendar holds the event itself at its old time.
    calendar.seedBusy(REF, [{ startUtc: new Date(start).toISOString(), endUtc: new Date(start + 4 * HOUR).toISOString() }]);
    const out = await rescheduleBookingV2(db, { accountId, uid, newStartMs: start + HOUR }, calendar);
    expect(out).toMatchObject({ ok: true });
    const movedUid = (out as { uid: string }).uid;
    // Something else just after its new end is still busy.
    calendar.seedBusy(REF, [
      { startUtc: new Date(start + HOUR).toISOString(), endUtc: new Date(start + 5 * HOUR).toISOString() },
      { startUtc: new Date(start + 5 * HOUR).toISOString(), endUtc: new Date(start + 6 * HOUR).toISOString() },
    ]);
    expect(await rescheduleBookingV2(db, { accountId, uid: movedUid, newStartMs: start + 2 * HOUR }, calendar)).toEqual({
      ok: false,
      reason: 'SLOT_TAKEN',
    });
  });

  it('with no copy on the calendar yet, busy time at its old time is something else and still refuses the move', async () => {
    const uid = await hostEvent();
    const calendar = new InMemoryCalendarProvider();
    // A meeting the host accepted elsewhere, inside the event's old time.
    calendar.seedBusy(REF, [{ startUtc: new Date(start + HOUR).toISOString(), endUtc: new Date(start + 1.5 * HOUR).toISOString() }]);
    expect(await rescheduleBookingV2(db, { accountId, uid, newStartMs: start + HOUR / 2 }, calendar)).toEqual({
      ok: false,
      reason: 'SLOT_TAKEN',
    });
  });

  it('the v1 move reads the calendar the same way', async () => {
    const uid = await hostEvent();
    await written(uid);
    const calendar = new InMemoryCalendarProvider();
    calendar.seedBusy(REF, [{ startUtc: new Date(start).toISOString(), endUtc: new Date(start + 4 * HOUR).toISOString() }]);
    // Any time (no event type), and not blocked by its own copy.
    expect(await rescheduleBooking(db, { uid, newStartMs: start + HOUR, byHost: true }, calendar)).toMatchObject({ ok: true });
    calendar.seedBusy(REF, [
      { startUtc: new Date(start + HOUR).toISOString(), endUtc: new Date(start + 5 * HOUR).toISOString() },
      { startUtc: new Date(start + 5 * HOUR).toISOString(), endUtc: new Date(start + 6 * HOUR).toISOString() },
    ]);
    expect(await rescheduleBooking(db, { uid, newStartMs: start + 2 * HOUR, byHost: true }, calendar)).toMatchObject({
      ok: false,
      reason: 'SLOT_TAKEN',
    });
  });

  it('busyOutside keeps only what lies outside the event being moved', () => {
    const at = (h: number) => new Date(start + h * HOUR);
    const own = { startMs: start + HOUR, endMs: start + 3 * HOUR };
    expect(busyOutside({ start: at(0), end: at(4) }, null)).toEqual([[start, start + 4 * HOUR]]);
    expect(busyOutside({ start: at(1), end: at(3) }, own)).toEqual([]);
    expect(busyOutside({ start: at(0), end: at(4) }, own)).toEqual([
      [start, start + HOUR],
      [start + 3 * HOUR, start + 4 * HOUR],
    ]);
    expect(busyOutside({ start: at(2), end: at(5) }, own)).toEqual([[start + 3 * HOUR, start + 5 * HOUR]]);
  });
});
