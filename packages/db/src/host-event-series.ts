/**
 * Repeating host events (ADR 0012): "every Wednesday at 15:30 with these four
 * people", put on the host's own calendar by the MCP `create_event` tool.
 *
 * A series is two things kept in step:
 *  - ONE repeating event on the host's calendar (written by the calendar
 *    effects, never here), so the attendees get one invitation for the series;
 *  - its dated occurrences as ordinary host-event `booking` rows (ADR 0011),
 *    linked by `booking.recurring_event_id`, so every date blocks the host's
 *    availability and is covered by the overlap check and, on Postgres, by
 *    `booking_no_overlap`. A series can never double-book the host.
 *
 * Occurrences are written ahead over a rolling horizon (`SERIES_HORIZON_DAYS`)
 * and the horizon is moved forward by a job (`extendHostEventSeries`), so a
 * series with no end stays correct over time without writing years of rows.
 * Each date is checked like a single event: another dCal booking is never
 * overlapped; busy time on the connected calendar and holds are refused,
 * skipped or overridden as the host chooses, and the answer names the dates.
 */
import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import type { CalendarProvider } from '@slate/calendar';
import {
  addCivilDays,
  civilDayDiff,
  endedBefore,
  isExclusionViolation,
  localDateParts,
  recurrenceProblem,
  remainderRule,
  RECURRENCE_WEEKDAYS,
  seriesOccurrences,
  shiftWeekdays,
  sortWeekdays,
  type Occurrence,
  type RecurrenceRule,
  type RecurrenceWeekday,
  type SeriesAnchor,
} from '@slate/engine';
import type { Db } from './client';
import { loadExternalBusy } from './calendar-refs';
import { normalizeAttendeeEmail } from './duplicate-guard';
import {
  bookingConflicts,
  holdConflicts,
  hostEventAttendees,
  HOST_EVENT_MAX_ATTENDEES,
  HOST_EVENT_MAX_MINUTES,
  HOST_EVENT_MIN_MINUTES,
  type HostEventConflict,
} from './host-event';
import {
  bookingStartOutOfRange,
  hostOverlapSql,
  jsonParam,
  memberHeldSql,
  parseJsonColumn,
  scopedIdempotencyKey,
} from './repository';

/** How far ahead a series' occurrences are written as bookings. */
export const SERIES_HORIZON_DAYS = 180;
export const SERIES_HORIZON_MS = SERIES_HORIZON_DAYS * 86_400_000;
/** The extension job moves a series' horizon once it is this much behind. */
export const SERIES_EXTEND_SLACK_MS = 86_400_000;
/** Most occurrences a counted series may have. */
export const SERIES_MAX_COUNT = 365;
/** How many dated conflicts a refusal or an answer lists. */
const MAX_LISTED = 20;
/** Upper bound for "the next date" lookups (the rule's own end stops them first). */
const NO_END = 8_640_000_000_000;
/** Enough rows to see every booking of a host over a horizon. */
const WINDOW_ROWS = 5000;

/** A conflict on one date of a series. */
export type SeriesConflict = HostEventConflict & { date: string };

/** A date left out of a series because something else was there. */
export interface SkippedDate {
  /** The date's start as the rule gives it (its original start). */
  startMs: number;
  /** YYYY-MM-DD in the series' zone. */
  date: string;
  /** booked: another dCal booking. busy: the connected calendar. held: someone was booking it. */
  reason: 'booked' | 'busy' | 'held';
}

export type SeriesStatus = 'active' | 'ended' | 'cancelled';

export interface HostEventSeries {
  id: string;
  accountId: string;
  hostMemberId: string;
  title: string;
  description: string | null;
  locationKind: string | null;
  anchor: SeriesAnchor;
  rule: RecurrenceRule;
  attendees: string[];
  status: SeriesStatus;
  materializedUntilMs: number;
  skipped: SkippedDate[];
  /** queued: the host has a calendar the series is written to. deleted: the calendar's event was removed. */
  calendarState: 'queued' | 'not_connected' | 'deleted';
  calendarDestination: string | null;
  calendarEventId: string | null;
  calendarCalendarId: string | null;
  meetingUrl: string | null;
  splitFrom: string | null;
  /** Bumped by every write that changes the series or its dates (see the schema). */
  revision: number;
  createdAt: number;
}

interface SeriesRow {
  id: string;
  account_id: string;
  host_member_id: string;
  title: string;
  description: string | null;
  location_kind: string | null;
  time_zone: string;
  start_date: string;
  start_time: string;
  duration_minutes: number | string;
  frequency: string;
  interval_count: number | string;
  weekdays: string;
  occurrence_count: number | string | null;
  until_date: string | null;
  attendees: unknown;
  status: string;
  materialized_until_ms: number | string;
  skipped: unknown;
  calendar_state: string;
  calendar_destination: string | null;
  calendar_event_id: string | null;
  calendar_calendar_id: string | null;
  meeting_url: string | null;
  split_from: string | null;
  revision: number | string;
  metadata: unknown;
  created_at: number | string;
}

function seriesFromRow(r: SeriesRow): HostEventSeries {
  const weekdays = r.weekdays
    .split(',')
    .map((w) => w.trim())
    .filter((w): w is RecurrenceWeekday => (RECURRENCE_WEEKDAYS as readonly string[]).includes(w));
  return {
    id: r.id,
    accountId: r.account_id,
    hostMemberId: r.host_member_id,
    title: r.title,
    description: r.description,
    locationKind: r.location_kind,
    anchor: {
      startDate: r.start_date,
      startTime: r.start_time,
      durationMinutes: Number(r.duration_minutes),
      timeZone: r.time_zone,
    },
    rule: {
      frequency: r.frequency === 'daily' ? 'daily' : 'weekly',
      interval: Number(r.interval_count),
      weekdays,
      count: r.occurrence_count == null ? null : Number(r.occurrence_count),
      untilDate: r.until_date,
    },
    attendees: parseJsonColumn<string[]>(r.attendees, []),
    status: r.status === 'cancelled' ? 'cancelled' : r.status === 'ended' ? 'ended' : 'active',
    materializedUntilMs: Number(r.materialized_until_ms),
    skipped: parseJsonColumn<SkippedDate[]>(r.skipped, []),
    calendarState: r.calendar_state === 'queued' ? 'queued' : r.calendar_state === 'deleted' ? 'deleted' : 'not_connected',
    calendarDestination: r.calendar_destination,
    calendarEventId: r.calendar_event_id,
    calendarCalendarId: r.calendar_calendar_id,
    meetingUrl: r.meeting_url,
    splitFrom: r.split_from,
    revision: Number(r.revision ?? 0),
    createdAt: Number(r.created_at),
  };
}

/** A series by id, optionally only within an account. */
export async function loadHostEventSeries(db: Db, id: string, accountId?: string): Promise<HostEventSeries | null> {
  const scope = accountId ? sql` AND account_id = ${accountId}` : sql``;
  const row = await db.get<SeriesRow>(sql`SELECT * FROM host_event_series WHERE id = ${id}${scope} LIMIT 1`);
  return row ? seriesFromRow(row) : null;
}

/** The first date of a series, as the rule gives it, or null for a rule left with none. */
export function firstOccurrenceOrNull(series: Pick<HostEventSeries, 'anchor' | 'rule'>): Occurrence | null {
  return seriesOccurrences(series.anchor, series.rule, { toMs: NO_END, max: 1 })[0] ?? null;
}

/** The first date of a series, as the rule gives it. */
export function firstOccurrence(series: Pick<HostEventSeries, 'anchor' | 'rule'>): Occurrence {
  const first = firstOccurrenceOrNull(series);
  if (!first) throw new RangeError('a series without dates');
  return first;
}

/** The original start of an occurrence (kept on the row when a date is moved on its own). */
export function occurrenceStartOf(metadata: unknown, startMs: number | string): number {
  const meta = parseJsonColumn<{ _series?: { occurrenceStartMs?: unknown } }>(metadata, {});
  const v = meta._series?.occurrenceStartMs;
  return typeof v === 'number' && Number.isFinite(v) ? v : Number(startMs);
}

/** One written occurrence of a series. */
export interface SeriesOccurrenceRow {
  id: string;
  uid: string;
  status: string;
  startMs: number;
  endMs: number;
  /** When the rule put it, before any move of that date alone. */
  occurrenceStartMs: number;
  /** True for a row replaced by a move (its date lives on in another row, or in a moved series). */
  rescheduled: boolean;
}

interface OccurrenceDbRow {
  id: string;
  uid: string;
  status: string;
  start_ms: number | string;
  end_ms: number | string;
  metadata: unknown;
  rescheduled: number | string | null;
}

function occurrenceFromRow(r: OccurrenceDbRow): SeriesOccurrenceRow {
  return {
    id: r.id,
    uid: r.uid,
    status: r.status,
    startMs: Number(r.start_ms),
    endMs: Number(r.end_ms),
    occurrenceStartMs: occurrenceStartOf(r.metadata, r.start_ms),
    rescheduled: Number(r.rescheduled ?? 0) === 1,
  };
}

const live = (r: { status: string }) => r.status === 'accepted' || r.status === 'pending';

/** Every written occurrence of a series (any status), by original start. */
export async function loadSeriesOccurrences(db: Db, seriesId: string): Promise<SeriesOccurrenceRow[]> {
  const rows = await db.all<OccurrenceDbRow>(
    sql`SELECT id, uid, status, start_ms, end_ms, metadata, rescheduled FROM booking WHERE recurring_event_id = ${seriesId}`,
  );
  return rows
    .map(occurrenceFromRow)
    .sort((a, b) => a.occurrenceStartMs - b.occurrenceStartMs || a.startMs - b.startMs);
}

/** The series a booking is an occurrence of, with that occurrence; null for any other booking. */
export async function seriesOfBooking(
  db: Db,
  uid: string,
  accountId?: string,
): Promise<{ series: HostEventSeries; occurrence: SeriesOccurrenceRow } | null> {
  const scope = accountId ? sql` AND b.account_id = ${accountId}` : sql``;
  const b = await db.get<OccurrenceDbRow & { recurring_event_id: string | null; event_type_id: string | null }>(
    sql`SELECT b.id, b.uid, b.status, b.start_ms, b.end_ms, b.metadata, b.rescheduled, b.recurring_event_id, b.event_type_id
        FROM booking b WHERE b.uid = ${uid}${scope} LIMIT 1`,
  );
  // Only a host event names a series here: `recurring_event_id` is never written otherwise.
  if (!b?.recurring_event_id || b.event_type_id != null) return null;
  const series = await loadHostEventSeries(db, b.recurring_event_id, accountId);
  if (!series) return null;
  return { series, occurrence: occurrenceFromRow(b) };
}

/** The local date of an instant in a zone, YYYY-MM-DD. */
function localDate(ms: number, timeZone: string): string {
  const p = localDateParts(new Date(ms), timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** The local wall clock of an instant in a zone, HH:mm. */
function localTime(ms: number, timeZone: string): string {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return f.format(new Date(ms));
}

/** The parts of [start, end) that none of `owns` covers. */
function outsideAll(start: number, end: number, owns: ReadonlyArray<{ startMs: number; endMs: number }>): Array<[number, number]> {
  let parts: Array<[number, number]> = [[start, end]];
  for (const own of owns) {
    parts = parts.flatMap(([a, b]): Array<[number, number]> => {
      if (b <= own.startMs || a >= own.endMs) return [[a, b]];
      const out: Array<[number, number]> = [];
      if (a < own.startMs) out.push([a, own.startMs]);
      if (b > own.endMs) out.push([own.endMs, b]);
      return out;
    });
  }
  return parts;
}

const overlaps = (a: { startMs: number; endMs: number }, b: { startMs: number; endMs: number }) =>
  a.startMs < b.endMs && a.endMs > b.startMs;

// --- The locked write, one body for both dialects --------------------------------

type TxStep = { get: SQL } | { all: SQL } | { run: SQL };

/** Thrown inside a locked write to roll it back and answer `result`. */
class Abort<R> {
  constructor(readonly result: R) {}
}

/**
 * Run `body` under the host's lock, as every guarded booking write does: SQLite
 * takes the write lock at BEGIN, Postgres locks the member row. The body yields
 * the statements; a `get` gets back the first row (or undefined), an `all`
 * every row. Throwing an
 * `Abort` rolls everything back and answers its result.
 */
async function lockedWrite<R>(db: Db, memberId: string, body: () => Generator<TxStep, R, unknown>): Promise<R> {
  try {
    if (db.dialect === 'sqlite') {
      const native = db.sqlite!;
      return native.txn(() => {
        const g = body();
        let step = g.next();
        while (!step.done) {
          const s = step.value;
          if ('get' in s) step = g.next(native.drizzle.get(s.get));
          else if ('all' in s) step = g.next(native.drizzle.all(s.all));
          else {
            native.drizzle.run(s.run);
            step = g.next(undefined);
          }
        }
        return step.value;
      }, { immediate: true });
    }
    return await db.pg!.drizzle.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM member WHERE id = ${memberId} FOR UPDATE`);
      const g = body();
      let step = g.next();
      while (!step.done) {
        const s = step.value;
        if ('get' in s) {
          const rows = (await tx.execute(s.get)) as unknown as unknown[];
          step = g.next(rows[0]);
        } else if ('all' in s) {
          step = g.next([...((await tx.execute(s.all)) as unknown as unknown[])]);
        } else {
          await tx.execute(s.run);
          step = g.next(undefined);
        }
      }
      return step.value;
    });
  } catch (err) {
    if (err instanceof Abort) return err.result as R;
    throw err;
  }
}

// --- Planning: which dates, and what is in the way ------------------------------

interface PlanInput {
  memberId: string;
  anchor: SeriesAnchor;
  rule: RecurrenceRule;
  now: number;
  allowConflicts: boolean;
  skipConflictingDates: boolean;
  calendar?: CalendarProvider;
  /** The occurrences this write replaces (a move): never conflicts, and their calendar time is the host's own. */
  replacing?: ReadonlyArray<SeriesOccurrenceRow>;
  /** Whether those occurrences are on the calendar (their series' event is written). */
  replacingOnCalendar?: boolean;
}

interface Plan {
  kept: Occurrence[];
  skipped: SkippedDate[];
  overridden: SeriesConflict[];
  calendarChecked: boolean;
  materializeToMs: number;
}

type Refusal =
  | { ok: false; reason: 'INVALID'; message: string }
  | { ok: false; reason: 'CALENDAR_UNAVAILABLE' }
  /** Another dCal booking on these dates: never overlapped. */
  | { ok: false; reason: 'SLOT_TAKEN'; conflicts: SeriesConflict[] }
  /** Busy time the host may choose to ignore or skip, by date. */
  | { ok: false; reason: 'CONFLICT'; conflicts: SeriesConflict[] }
  /** Every date had something in the way, so nothing would be left. */
  | { ok: false; reason: 'NO_DATES_LEFT'; conflicts: SeriesConflict[] };

/**
 * The dates a series would be written on over its horizon, each checked like
 * a single host event. Read outside the lock to list what is in the way; the
 * write checks the dCal side again under it.
 */
async function planSeries(db: Db, input: PlanInput): Promise<{ ok: true; plan: Plan } | Refusal> {
  const { anchor, rule, now } = input;
  const first = seriesOccurrences(anchor, rule, { toMs: NO_END, max: 1 })[0];
  if (!first) return { ok: false, reason: 'INVALID', message: 'The series has no dates.' };
  const rangeErr = bookingStartOutOfRange(first.startMs, now);
  if (rangeErr) return { ok: false, reason: 'INVALID', message: rangeErr };
  const materializeToMs = Math.max(now, first.startMs) + SERIES_HORIZON_MS;
  const dates = seriesOccurrences(anchor, rule, { toMs: materializeToMs });
  if (dates.length === 0) return { ok: false, reason: 'INVALID', message: 'The series has no dates.' };
  const fromMs = dates[0]!.startMs;
  const toMs = dates[dates.length - 1]!.endMs;

  const replacing = input.replacing ?? [];
  const replacingUids = new Set(replacing.map((r) => r.uid));
  const booked = (await bookingConflicts(db, input.memberId, fromMs, toMs, WINDOW_ROWS)).filter(
    (b) => b.kind !== 'booking' || !replacingUids.has(b.uid),
  );
  const holds = await holdConflicts(db, input.memberId, fromMs, toMs, now, WINDOW_ROWS);
  let external: HostEventConflict[] = [];
  let calendarChecked = true;
  try {
    const busy = await loadExternalBusy(db, input.calendar, input.memberId, fromMs, toMs, null);
    // The occurrences being replaced are on the calendar as the host's own time.
    const own = input.replacingOnCalendar ? replacing.filter((r) => r.status === 'accepted') : [];
    external = busy
      .flatMap((b) => outsideAll(b.start.getTime(), b.end.getTime(), own))
      // A dCal booking is on the calendar too: list it once, as the booking.
      .filter(([s, e]) => !booked.some((k) => k.startMs === s && k.endMs === e))
      .map(([s, e]) => ({ kind: 'calendar' as const, startMs: s, endMs: e }));
  } catch {
    // Fail closed, as for a single event: an unreadable calendar is not a free one.
    if (!input.allowConflicts) return { ok: false, reason: 'CALENDAR_UNAVAILABLE' };
    calendarChecked = false;
  }

  const kept: Occurrence[] = [];
  const skipped: SkippedDate[] = [];
  const hardListed: SeriesConflict[] = [];
  const softListed: SeriesConflict[] = [];
  for (const o of dates) {
    const hard = booked.filter((b) => overlaps(b, o));
    const soft = [...holds, ...external].filter((b) => overlaps(b, o));
    for (const c of hard) hardListed.push({ ...c, date: o.date });
    if (hard.length === 0) for (const c of soft) softListed.push({ ...c, date: o.date });
    if (hard.length > 0) skipped.push({ startMs: o.startMs, date: o.date, reason: 'booked' });
    else if (soft.length > 0 && !input.allowConflicts)
      skipped.push({ startMs: o.startMs, date: o.date, reason: soft.some((c) => c.kind === 'calendar') ? 'busy' : 'held' });
    else kept.push(o);
  }
  if (hardListed.length > 0 && !input.skipConflictingDates)
    return { ok: false, reason: 'SLOT_TAKEN', conflicts: [...hardListed, ...softListed].slice(0, MAX_LISTED) };
  if (softListed.length > 0 && !input.allowConflicts && !input.skipConflictingDates)
    return { ok: false, reason: 'CONFLICT', conflicts: softListed.slice(0, MAX_LISTED) };
  if (kept.length === 0)
    return { ok: false, reason: 'NO_DATES_LEFT', conflicts: [...hardListed, ...softListed].slice(0, MAX_LISTED) };
  return {
    ok: true,
    plan: {
      kept,
      skipped,
      overridden: input.allowConflicts ? softListed.slice(0, MAX_LISTED) : [],
      calendarChecked,
      materializeToMs,
    },
  };
}

// --- Writing occurrences ---------------------------------------------------------

interface OccurrenceSource {
  seriesId: string;
  /** The series' revision this write makes: part of each date's key. */
  revision: number;
  accountId: string;
  memberId: string;
  title: string;
  description: string | null;
  locationKind: string | null;
  timeZone: string;
  attendees: string[];
  calendar: 'queued' | 'not_connected';
  calendarChecked: boolean;
}

/** The statements that write one occurrence: the booking and its attendees. */
function occurrenceInsert(
  db: Db,
  s: OccurrenceSource,
  o: Pick<Occurrence, 'startMs' | 'endMs'>,
  overridden: HostEventConflict[],
  now: number,
): { uid: string; key: string; statements: SQL[] } {
  const bookingId = randomUUID();
  const uid = randomUUID();
  const key = occurrenceKey(s.accountId, s.seriesId, s.revision, o.startMs);
  const metadata = {
    _hostEvent: { by: 'mcp', calendar: s.calendar, calendarChecked: s.calendarChecked, overridden },
    _series: { id: s.seriesId, occurrenceStartMs: o.startMs },
  };
  const statements: SQL[] = [
    sql`INSERT INTO booking (id, account_id, uid, event_type_id, host_member_id, title, calendar_description,
          location, location_kind, start_ms, end_ms, status, metadata, attendee_time_zone, idempotency_key,
          recurring_event_id, seated, created_at, updated_at)
        VALUES (${bookingId}, ${s.accountId}, ${uid}, NULL, ${s.memberId}, ${s.title}, ${s.description},
          NULL, ${s.locationKind}, ${o.startMs}, ${o.endMs}, 'accepted', ${jsonParam(db, metadata)}, ${s.timeZone},
          ${key}, ${s.seriesId}, 1, ${now}, ${now})`,
    ...s.attendees.map(
      (email, i) => sql`
        INSERT INTO booking_attendee (id, booking_id, name, email, email_normalized, time_zone, created_at)
        VALUES (${randomUUID()}, ${bookingId}, ${email}, ${email}, ${normalizeAttendeeEmail(email)}, ${s.timeZone}, ${now + i})`,
    ),
  ];
  return { uid, key, statements };
}

/**
 * The key an occurrence is written under: one per series, revision and date
 * (`booking.idempotency_key` is unique), so one write can never put a date in
 * twice, while a later revision (a whole series moved onto its own old times)
 * writes those times again instead of finding the cancelled rows' keys.
 */
function occurrenceKey(accountId: string, seriesId: string, revision: number, startMs: number): string {
  return scopedIdempotencyKey(accountId, `series:${seriesId}:${revision}:${startMs}`);
}

/**
 * Under the lock: check each planned date again for a dCal booking (and a hold,
 * unless the host chose to ignore them), then write the ones that are clear.
 * Without `skip`, one taken date refuses the whole write. Yields the
 * statements for `lockedWrite`; answers the dates written and those skipped now.
 */
function* writeOccurrences(
  db: Db,
  source: OccurrenceSource,
  kept: readonly Occurrence[],
  opts: { allowConflicts: boolean; skip: boolean; now: number; overridden: readonly SeriesConflict[] },
): Generator<TxStep, { written: Array<{ uid: string; startMs: number }>; skipped: SkippedDate[] }, unknown> {
  const clear: Occurrence[] = [];
  const skipped: SkippedDate[] = [];
  for (const o of kept) {
    // Already written (a replica extended it first): nothing to do for that date.
    if (
      yield {
        get: sql`SELECT id FROM booking WHERE idempotency_key = ${occurrenceKey(source.accountId, source.seriesId, source.revision, o.startMs)} LIMIT 1`,
      }
    )
      continue;
    if (yield { get: hostOverlapSql(source.memberId, o.startMs, o.endMs) }) {
      if (!opts.skip) throw new Abort({ ok: false as const, reason: 'SLOT_TAKEN' as const, date: o.date });
      skipped.push({ startMs: o.startMs, date: o.date, reason: 'booked' });
      continue;
    }
    if (!opts.allowConflicts && (yield { get: memberHeldSql(source.memberId, o.startMs, o.endMs, opts.now) })) {
      if (!opts.skip) throw new Abort({ ok: false as const, reason: 'CONFLICT' as const, date: o.date });
      skipped.push({ startMs: o.startMs, date: o.date, reason: 'held' });
      continue;
    }
    clear.push(o);
  }
  const written: Array<{ uid: string; startMs: number }> = [];
  for (const [i, o] of clear.entries()) {
    const ignored = opts.overridden.filter((c) => c.date === o.date).map(({ date: _date, ...c }) => c);
    const ins = occurrenceInsert(db, source, o, ignored, opts.now + i);
    for (const statement of ins.statements) yield { run: statement };
    written.push({ uid: ins.uid, startMs: o.startMs });
  }
  return { written, skipped };
}

// --- Create ----------------------------------------------------------------------

export interface CreateHostEventSeriesArgs {
  accountId: string;
  memberId: string;
  title: string;
  description?: string | null;
  videoLink?: boolean;
  attendees: string[];
  /** The rule: first date, local time, length and zone (the wall clock every date keeps). */
  anchor: SeriesAnchor;
  rule: RecurrenceRule;
  /** Write it over busy time on the connected calendar and holds. */
  allowConflicts?: boolean;
  /** Leave out the dates where something is in the way, instead of refusing. */
  skipConflictingDates?: boolean;
  /** Whether the caller queues the calendar write for it (the host has a calendar). */
  calendarQueued?: boolean;
  /** The host's destination calendar at creation, the one the series is written to. */
  calendarDestination?: string | null;
  idempotencyKey?: string;
  requestHash?: string;
  now?: number;
}

export type HostSeriesOutcome =
  | {
      ok: true;
      seriesId: string;
      /** The first date written: the booking an agent reads the series through. */
      firstUid: string;
      replayed: boolean;
      /** How many dates were written as bookings now (the horizon). */
      occurrences: number;
      /** Dates left out (only with `skipConflictingDates`). */
      skipped: SkippedDate[];
      /** Busy time it was written over (`allowConflicts`), by date. */
      overridden: SeriesConflict[];
      calendarChecked: boolean;
      calendarQueued: boolean;
      /** Dates before this are written as bookings; later ones are written as the horizon moves. */
      materializedUntilMs: number;
    }
  | { ok: false; reason: 'NOT_FOUND' | 'IDEMPOTENCY_KEY_REUSED' | 'CALENDAR_UNAVAILABLE' }
  | { ok: false; reason: 'INVALID'; message: string }
  | { ok: false; reason: 'SLOT_TAKEN' | 'CONFLICT' | 'NO_DATES_LEFT'; conflicts: SeriesConflict[] };

/** What a series keeps of its own creation (`metadata._created`), for replays. */
interface StoredCreation {
  firstUid: string;
  occurrences: number;
  skipped: SkippedDate[];
  overridden: SeriesConflict[];
  calendarChecked: boolean;
}

/**
 * The series a repeated key already made: replayed, or refused when the key
 * came with other arguments. Null when the key has made nothing.
 */
export async function replayHostEventSeries(
  db: Db,
  accountId: string,
  key: string,
  requestHash: string | undefined,
): Promise<HostSeriesOutcome | null> {
  const row = await db.get<{ id: string; metadata: unknown; calendar_state: string; materialized_until_ms: number | string }>(
    sql`SELECT id, metadata, calendar_state, materialized_until_ms FROM host_event_series
        WHERE account_id = ${accountId} AND idempotency_key = ${scopedIdempotencyKey(accountId, key)} LIMIT 1`,
  );
  if (!row) return null;
  const meta = parseJsonColumn<{ _idempotency?: { requestHash?: string | null }; _created?: Partial<StoredCreation> }>(row.metadata, {});
  if ((meta._idempotency?.requestHash ?? null) !== (requestHash ?? null)) return { ok: false, reason: 'IDEMPOTENCY_KEY_REUSED' };
  const made = meta._created ?? {};
  return {
    ok: true,
    seriesId: row.id,
    firstUid: made.firstUid ?? '',
    replayed: true,
    occurrences: made.occurrences ?? 0,
    skipped: Array.isArray(made.skipped) ? made.skipped : [],
    overridden: Array.isArray(made.overridden) ? made.overridden : [],
    calendarChecked: made.calendarChecked !== false,
    calendarQueued: row.calendar_state !== 'not_connected',
    materializedUntilMs: Number(row.materialized_until_ms),
  };
}

/** Why the shared parts of a series are not valid, or null. */
function seriesProblem(anchor: SeriesAnchor, rule: RecurrenceRule): string | null {
  if (anchor.durationMinutes < HOST_EVENT_MIN_MINUTES)
    return `Each occurrence must last at least ${HOST_EVENT_MIN_MINUTES} minutes.`;
  if (anchor.durationMinutes > HOST_EVENT_MAX_MINUTES) return 'Each occurrence can last at most 24 hours.';
  if (rule.count !== null && rule.count > SERIES_MAX_COUNT) return `A series can have at most ${SERIES_MAX_COUNT} dates.`;
  return recurrenceProblem(anchor, rule);
}

/**
 * Put a repeating event on a host's calendar (see the module comment). Every
 * date over the horizon is checked first; nothing is written when one is in
 * the way, unless the host chose to skip such dates or to ignore what they may
 * ignore. The calendar write-out is the caller's to enqueue.
 */
export async function createHostEventSeries(
  db: Db,
  args: CreateHostEventSeriesArgs,
  calendar?: CalendarProvider,
): Promise<HostSeriesOutcome> {
  const member = await db.get<{ id: string; status: string; email: string | null }>(
    sql`SELECT id, status, email FROM member WHERE id = ${args.memberId} AND account_id = ${args.accountId} LIMIT 1`,
  );
  if (member?.status !== 'active') return { ok: false, reason: 'NOT_FOUND' };
  const title = args.title.trim();
  if (!title) return { ok: false, reason: 'INVALID', message: 'The event needs a title.' };
  const rule: RecurrenceRule = { ...args.rule, weekdays: sortWeekdays(args.rule.weekdays) };
  const problem = seriesProblem(args.anchor, rule);
  if (problem) return { ok: false, reason: 'INVALID', message: problem };
  const attendees = hostEventAttendees(args.attendees, member.email);
  if (attendees.length > HOST_EVENT_MAX_ATTENDEES)
    return { ok: false, reason: 'INVALID', message: `At most ${HOST_EVENT_MAX_ATTENDEES} attendees.` };

  const key = args.idempotencyKey;
  const replay = () => (key ? replayHostEventSeries(db, args.accountId, key, args.requestHash) : Promise.resolve(null));
  {
    const prior = await replay();
    if (prior) return prior;
  }
  const refuse = async (out: HostSeriesOutcome): Promise<HostSeriesOutcome> => (await replay()) ?? out;

  const now = args.now ?? Date.now();
  const allowConflicts = args.allowConflicts === true;
  const skip = args.skipConflictingDates === true;
  const planned = await planSeries(db, {
    memberId: member.id,
    anchor: args.anchor,
    rule,
    now,
    allowConflicts,
    skipConflictingDates: skip,
    calendar,
  });
  if (!planned.ok) return refuse(planned);
  const { plan } = planned;
  if (!args.calendarQueued && !noDatesFrom(args.anchor, rule, plan.materializeToMs))
    return { ok: false, reason: 'INVALID', message: NEEDS_CALENDAR_TO_REPEAT };

  const seriesId = randomUUID();
  const description = args.description?.trim() ? args.description.trim() : null;
  const locationKind = args.videoLink ? 'conferencing' : 'custom';
  const calendarState = args.calendarQueued ? 'queued' : 'not_connected';
  const storedKey = key ? scopedIdempotencyKey(args.accountId, key) : null;
  const source: OccurrenceSource = {
    seriesId,
    revision: 0,
    accountId: args.accountId,
    memberId: member.id,
    title,
    description,
    locationKind,
    timeZone: args.anchor.timeZone,
    attendees,
    calendar: calendarState,
    calendarChecked: plan.calendarChecked,
  };

  type Written =
    | { ok: true; written: Array<{ uid: string; startMs: number }>; skipped: SkippedDate[] }
    | { ok: false; reason: 'replay' }
    | { ok: false; reason: 'SLOT_TAKEN' | 'CONFLICT'; date: string };
  let result: Written;
  try {
    result = await lockedWrite<Written>(db, member.id, function* () {
      if (storedKey && (yield { get: sql`SELECT id FROM host_event_series WHERE idempotency_key = ${storedKey} LIMIT 1` }))
        return { ok: false, reason: 'replay' };
      const out = yield* writeOccurrences(db, source, plan.kept, { allowConflicts, skip, now, overridden: plan.overridden });
      if (out.written.length === 0) throw new Abort({ ok: false as const, reason: 'SLOT_TAKEN' as const, date: plan.kept[0]!.date });
      const skipped = [...plan.skipped, ...out.skipped].sort((a, b) => a.startMs - b.startMs);
      const created: StoredCreation = {
        firstUid: out.written[0]!.uid,
        occurrences: out.written.length,
        skipped,
        overridden: plan.overridden,
        calendarChecked: plan.calendarChecked,
      };
      const metadata = { _created: created, ...(key ? { _idempotency: { requestHash: args.requestHash ?? null } } : {}) };
      yield {
        run: sql`INSERT INTO host_event_series (id, account_id, host_member_id, title, description, location_kind,
              time_zone, start_date, start_time, duration_minutes, frequency, interval_count, weekdays,
              occurrence_count, until_date, attendees, status, materialized_until_ms, skipped, calendar_state,
              calendar_destination, idempotency_key, metadata, created_at, updated_at)
            VALUES (${seriesId}, ${args.accountId}, ${member.id}, ${title}, ${description}, ${locationKind},
              ${args.anchor.timeZone}, ${args.anchor.startDate}, ${args.anchor.startTime}, ${args.anchor.durationMinutes},
              ${rule.frequency}, ${rule.interval}, ${rule.weekdays.join(',')}, ${rule.count}, ${rule.untilDate},
              ${jsonParam(db, attendees)}, 'active', ${plan.materializeToMs}, ${jsonParam(db, skipped)}, ${calendarState},
              ${args.calendarQueued ? (args.calendarDestination ?? null) : null}, ${storedKey},
              ${jsonParam(db, metadata)}, ${now}, ${now})`,
      };
      return { ok: true, written: out.written, skipped };
    });
  } catch (err) {
    const prior = await replay();
    if (prior) return prior;
    if (!isExclusionViolation(err)) throw err;
    result = { ok: false, reason: 'SLOT_TAKEN', date: '' };
  }
  if (!result.ok) {
    if (result.reason === 'replay') return (await replay()) ?? { ok: false, reason: 'IDEMPOTENCY_KEY_REUSED' };
    // Something took a date between the read and the lock: answer what is there now.
    const again = await planSeries(db, { memberId: member.id, anchor: args.anchor, rule, now, allowConflicts, skipConflictingDates: false, calendar });
    return refuse(again.ok ? { ok: false, reason: result.reason, conflicts: [] } : again);
  }
  return {
    ok: true,
    seriesId,
    firstUid: result.written[0]!.uid,
    replayed: false,
    occurrences: result.written.length,
    skipped: result.skipped,
    overridden: plan.overridden,
    calendarChecked: plan.calendarChecked,
    calendarQueued: args.calendarQueued === true,
    materializedUntilMs: plan.materializeToMs,
  };
}

// --- The rolling horizon ---------------------------------------------------------

/** Active series whose written dates end too close to now: the extension job's work list. */
export async function listSeriesDueForExtension(db: Db, now: number = Date.now(), limit = 50): Promise<string[]> {
  const rows = await db.all<{ id: string }>(
    sql`SELECT id FROM host_event_series
        WHERE status = 'active' AND materialized_until_ms < ${now + SERIES_HORIZON_MS - SERIES_EXTEND_SLACK_MS}
        ORDER BY materialized_until_ms ASC, id ASC LIMIT ${limit}`,
  );
  return rows.map((r) => r.id);
}

export interface SeriesExtension {
  seriesId: string;
  /** Dates written as bookings now. */
  added: number;
  /**
   * Dates that met another dCal booking (booked beyond the horizon) and were
   * left out. Their occurrence is on the calendar: the caller cancels it there.
   */
  skipped: SkippedDate[];
  /** True when the rule has no dates left to write: the series is now `ended`. */
  ended: boolean;
}

/**
 * Whether a series' rule has no dates from `fromMs` on. A series no calendar
 * holds must end within its horizon: past it, nothing would keep its dates
 * busy until the extension writes them.
 */
function noDatesFrom(anchor: SeriesAnchor, rule: RecurrenceRule, fromMs: number): boolean {
  return seriesOccurrences(anchor, rule, { fromMs, toMs: NO_END, max: 1 }).length === 0;
}

const NEEDS_CALENDAR_TO_REPEAT =
  `Without a connected calendar, a repeating event must end within ${SERIES_HORIZON_DAYS} days (give count or until): only the calendar keeps its later dates busy.`;

/** The series' revision under the lock, or null when it changed since `expected` (the caller starts over). */
function* sameRevision(seriesId: string, expected: number): Generator<TxStep, boolean, unknown> {
  const fresh = (yield { get: sql`SELECT revision FROM host_event_series WHERE id = ${seriesId} LIMIT 1` }) as
    | { revision: number | string }
    | undefined;
  return !!fresh && Number(fresh.revision) === expected;
}

/** Thrown inside a locked write that read an older revision: roll back and start over. */
const STALE = Symbol('stale series');

/**
 * Write the dates that came within the horizon since the series was last
 * extended. Only another dCal booking stops a date now: the host accepted the
 * series when it was made, and the calendar already shows its own future
 * dates as busy, so it is not read. Safe on several replicas at once: the
 * write gives way when the series' revision changed since it was read (another
 * replica, a cancel, a move), and each date is keyed once per revision.
 * Nothing is written for a host who is no longer an active member, and no
 * date already started is written.
 */
export async function extendHostEventSeries(db: Db, seriesId: string, now: number = Date.now()): Promise<SeriesExtension | null> {
  const series = await loadHostEventSeries(db, seriesId);
  if (!series || series.status !== 'active') return null;
  const member = await db.get<{ status: string }>(sql`SELECT status FROM member WHERE id = ${series.hostMemberId} LIMIT 1`);
  if (member?.status !== 'active') return null;
  const targetMs = now + SERIES_HORIZON_MS;
  if (series.materializedUntilMs >= targetMs - SERIES_EXTEND_SLACK_MS) return { seriesId, added: 0, skipped: [], ended: false };
  const dates = seriesOccurrences(series.anchor, series.rule, { fromMs: Math.max(series.materializedUntilMs, now), toMs: targetMs });
  const ended = noDatesFrom(series.anchor, series.rule, targetMs);
  const revision = series.revision + 1;
  const source: OccurrenceSource = {
    seriesId,
    revision,
    accountId: series.accountId,
    memberId: series.hostMemberId,
    title: series.title,
    description: series.description,
    locationKind: series.locationKind,
    timeZone: series.anchor.timeZone,
    attendees: series.attendees,
    calendar: series.calendarState === 'queued' ? 'queued' : 'not_connected',
    calendarChecked: true,
  };
  return lockedWrite(db, series.hostMemberId, function* () {
    // Another replica, or a cancel or a move, got here first: nothing to do now.
    if (!(yield* sameRevision(seriesId, series.revision))) return { seriesId, added: 0, skipped: [], ended: false };
    // A hold lasts minutes; a date months away is not refused for one.
    const out = yield* writeOccurrences(db, source, dates, { allowConflicts: true, skip: true, now, overridden: [] });
    const skipped = [...series.skipped, ...out.skipped];
    yield {
      run: sql`UPDATE host_event_series
          SET materialized_until_ms = ${targetMs}, skipped = ${jsonParam(db, skipped)}, revision = ${revision},
              status = ${ended ? 'ended' : 'active'}, updated_at = ${now}
          WHERE id = ${seriesId}`,
    };
    return { seriesId, added: out.written.length, skipped: out.skipped, ended };
  });
}

// --- Cancel ----------------------------------------------------------------------

export type SeriesScope = 'this_and_following' | 'series';

export type SeriesCancelOutcome =
  | {
      ok: true;
      seriesId: string;
      /** The occurrences cancelled now. */
      cancelled: string[];
      /**
       * What the calendar must do with the series' event: `delete` it (nothing
       * of the series is left), `trim` it (end it before the first cancelled
       * date), or `none` (no calendar, or nothing changed).
       */
      calendar: 'delete' | 'trim' | 'none';
      /**
       * Dates moved on their own to after the cut that the rule's new end
       * does not reach (their original start is before it): cancelled one by
       * one on the calendar, by original start.
       */
      occurrenceCancels: number[];
      /** True when it was already cancelled that far: nothing changed. */
      alreadyApplied: boolean;
    }
  | { ok: false; reason: 'NOT_FOUND' | 'NOT_A_SERIES' };

/** The date of an instant in the series' zone. */
const dateIn = (series: HostEventSeries, ms: number) => localDate(ms, series.anchor.timeZone);

/**
 * Where a change from a date on starts, in the rule's terms. `this_and_following`:
 * the date's own original start, unless that date has started. `series` (and a
 * date that has started): the first date of the rule that has not started.
 * Null when the rule has no such date.
 */
function cutFor(series: HostEventSeries, scope: SeriesScope, pivotOriginalMs: number, now: number): number | null {
  if (scope === 'this_and_following' && pivotOriginalMs > now) return pivotOriginalMs;
  return seriesOccurrences(series.anchor, series.rule, { fromMs: now + 1, toMs: NO_END, max: 1 })[0]?.startMs ?? null;
}

/**
 * Cancel the dates of a series from one on: `this_and_following` from the
 * occurrence `uid`, `series` from the first that has not started. Dates
 * already started stay as they were, whichever the scope. Every written date
 * from the cut on is cancelled, and the rule ends before it, so the extension
 * writes no more and the calendar's repeating event is cut there; when nothing
 * of the series has started, the series is cancelled whole and its event
 * deleted. Decided under the host's lock on the series as it is then (a write
 * that read an older revision starts over). dCal emails nobody: the calendar
 * tells the attendees.
 */
export async function cancelHostEventSeries(
  db: Db,
  args: { accountId: string; uid: string; scope: SeriesScope; reason?: string | null; now?: number },
): Promise<SeriesCancelOutcome> {
  const now = args.now ?? Date.now();
  const reason = args.reason?.trim() ? args.reason.trim() : null;
  for (let attempt = 0; ; attempt++) {
    const found = await seriesOfBooking(db, args.uid, args.accountId);
    if (!found) {
      const exists = await db.get(sql`SELECT id FROM booking WHERE uid = ${args.uid} AND account_id = ${args.accountId} LIMIT 1`);
      return { ok: false, reason: exists ? 'NOT_A_SERIES' : 'NOT_FOUND' };
    }
    const { series } = found;
    const done = { ok: true as const, seriesId: series.id, cancelled: [], calendar: 'none' as const, occurrenceCancels: [], alreadyApplied: true };
    if (series.status === 'cancelled') return done;
    const first = firstOccurrence(series);
    const started = first.startMs <= now;
    const cutMs = cutFor(series, args.scope, found.occurrence.occurrenceStartMs, now);
    const wholeSeries = !started && (cutMs === null || cutMs <= first.startMs);
    const cutDate = cutMs === null ? null : dateIn(series, cutMs);
    const newRule = !wholeSeries && cutDate ? endedBefore(series.rule, cutDate) : series.rule;
    const ruleChanges =
      !wholeSeries &&
      cutDate !== null &&
      (series.rule.untilDate === null || civilDayDiff(newRule.untilDate!, series.rule.untilDate) > 0) &&
      // A count that already ends before the cut is not cut again.
      seriesOccurrences(series.anchor, series.rule, { fromMs: cutMs!, toMs: NO_END, max: 1 }).length > 0;
    const onCalendar = series.calendarState === 'queued';
    const result = await lockedWrite<SeriesOccurrenceRow[] | null | typeof STALE>(db, series.hostMemberId, function* () {
      if (!(yield* sameRevision(series.id, series.revision))) throw new Abort(STALE);
      const rows = ((yield {
        all: sql`SELECT id, uid, status, start_ms, end_ms, metadata, rescheduled FROM booking WHERE recurring_event_id = ${series.id}`,
      }) as OccurrenceDbRow[]).map(occurrenceFromRow);
      // Never a date that has started, and with `series` every date not started.
      const toCancel = rows.filter(
        (r) =>
          live(r) && r.startMs > now && (wholeSeries || args.scope === 'series' || (cutMs !== null && r.occurrenceStartMs >= cutMs)),
      );
      if (toCancel.length === 0 && !ruleChanges && !wholeSeries) return null;
      for (const r of toCancel) {
        yield {
          run: sql`UPDATE booking SET status = 'cancelled', cancellation_reason = ${reason}, cancelled_by = 'host',
                updated_at = ${now}
              WHERE id = ${r.id} AND status IN ('accepted','pending')`,
        };
      }
      if (wholeSeries) {
        yield {
          run: sql`UPDATE host_event_series SET status = 'cancelled', revision = ${series.revision + 1}, updated_at = ${now}
              WHERE id = ${series.id}`,
        };
      } else if (ruleChanges) {
        yield {
          run: sql`UPDATE host_event_series
              SET occurrence_count = NULL, until_date = ${newRule.untilDate}, revision = ${series.revision + 1}, updated_at = ${now},
                  status = CASE WHEN materialized_until_ms >= ${cutMs} THEN 'ended' ELSE status END
              WHERE id = ${series.id}`,
        };
      } else {
        yield { run: sql`UPDATE host_event_series SET revision = ${series.revision + 1}, updated_at = ${now} WHERE id = ${series.id}` };
      }
      return toCancel;
    });
    if (result === STALE) {
      if (attempt < 3) continue;
      throw new Error(`series ${series.id} kept changing while it was cancelled`);
    }
    if (result === null) return done;
    const cancelled = result as SeriesOccurrenceRow[];
    return {
      ok: true,
      seriesId: series.id,
      cancelled: cancelled.map((r) => r.uid),
      calendar: !onCalendar ? 'none' : wholeSeries ? 'delete' : ruleChanges ? 'trim' : 'none',
      // A date moved on its own whose original start the new end still covers stays on the calendar unless cancelled alone.
      occurrenceCancels:
        onCalendar && !wholeSeries
          ? cancelled.filter((r) => cutMs === null || r.occurrenceStartMs < cutMs).map((r) => r.occurrenceStartMs)
          : [],
      alreadyApplied: false,
    };
  }
}

// --- Move ------------------------------------------------------------------------

export interface MoveHostEventSeriesArgs {
  accountId: string;
  /** An occurrence of the series: the pivot for `this_and_following`. */
  uid: string;
  scope: SeriesScope;
  /** Where the pivot date moves to; every later date moves the same way in local time. */
  newStartMs: number;
  allowConflicts?: boolean;
  skipConflictingDates?: boolean;
  now?: number;
}

export type SeriesMoveOutcome =
  | {
      ok: true;
      /** The series the dates are on now: the same one (moved whole) or a new one (split). */
      seriesId: string;
      /** The series it was split from, when it was; null when the series moved whole. */
      previousSeriesId: string | null;
      firstUid: string;
      /** True when the series already was there (a whole series moved to its own rule): nothing changed. */
      alreadyApplied: boolean;
      cancelled: string[];
      occurrences: number;
      skipped: SkippedDate[];
      overridden: SeriesConflict[];
      calendarChecked: boolean;
      /** Whether the series is written to a calendar (the caller queues the change). */
      calendarQueued: boolean;
    }
  | { ok: false; reason: 'NOT_FOUND' | 'NOT_A_SERIES' | 'CALENDAR_UNAVAILABLE' | 'GONE' }
  | { ok: false; reason: 'INVALID'; message: string }
  | { ok: false; reason: 'SLOT_TAKEN' | 'CONFLICT' | 'NO_DATES_LEFT'; conflicts: SeriesConflict[] };

/**
 * Move a series from one date on to a new local time (and, with it, a new
 * weekday): `this_and_following` from the occurrence `uid`, `series` from the
 * first date that has not started. Dates that have started stay where they
 * were. When the move starts at the series' first date and nothing has
 * started, the whole series moves and keeps its calendar event (the attendees
 * see it move); otherwise the series ends before it and the rest continues as
 * a new series (the attendees get it as its own invitation). Each new date is
 * checked as on creation. `uid` must be a date that is still on: a date moved
 * or cancelled already answers GONE (a retry of a move is answered by the
 * caller's idempotency key, never by moving again).
 */
export async function moveHostEventSeries(
  db: Db,
  args: MoveHostEventSeriesArgs,
  calendar?: CalendarProvider,
): Promise<SeriesMoveOutcome> {
  const now = args.now ?? Date.now();
  for (let attempt = 0; ; attempt++) {
    const found = await seriesOfBooking(db, args.uid, args.accountId);
    if (!found) {
      const exists = await db.get(sql`SELECT id FROM booking WHERE uid = ${args.uid} AND account_id = ${args.accountId} LIMIT 1`);
      return { ok: false, reason: exists ? 'NOT_A_SERIES' : 'NOT_FOUND' };
    }
    const { series } = found;
    if (series.status === 'cancelled' || !live(found.occurrence)) return { ok: false, reason: 'GONE' };
    const tz = series.anchor.timeZone;
    const first = firstOccurrence(series);
    const started = first.startMs <= now;
    const pivotMs = cutFor(series, args.scope, found.occurrence.occurrenceStartMs, now);
    if (pivotMs === null) return { ok: false, reason: 'GONE' };
    const pivotIndex = seriesOccurrences(series.anchor, series.rule, { toMs: pivotMs }).length;
    const pivotDate = localDate(pivotMs, tz);
    const newDate = localDate(args.newStartMs, tz);
    const newTime = localTime(args.newStartMs, tz);
    const shift = civilDayDiff(pivotDate, newDate);
    const anchor: SeriesAnchor = { ...series.anchor, startDate: newDate, startTime: newTime };
    const rule: RecurrenceRule = {
      ...remainderRule(series.rule, pivotIndex),
      weekdays: series.rule.frequency === 'weekly' ? shiftWeekdays(series.rule.weekdays, shift) : [],
    };
    if (rule.untilDate !== null && civilDayDiff(newDate, rule.untilDate) < 0)
      return { ok: false, reason: 'INVALID', message: `The series ends on ${rule.untilDate}, before the new date.` };
    const problem = seriesProblem(anchor, rule);
    if (problem) return { ok: false, reason: 'INVALID', message: problem };
    // Whole only when nothing has started and the move starts at the first date.
    const whole = pivotIndex === 0 && !started;
    const rows = await loadSeriesOccurrences(db, series.id);
    if (
      whole &&
      series.anchor.startDate === anchor.startDate &&
      series.anchor.startTime === anchor.startTime &&
      series.rule.weekdays.join(',') === rule.weekdays.join(',')
    ) {
      const accepted = rows.filter(live);
      return {
        ok: true,
        seriesId: series.id,
        previousSeriesId: null,
        firstUid: accepted[0]?.uid ?? found.occurrence.uid,
        alreadyApplied: true,
        cancelled: [],
        occurrences: accepted.length,
        skipped: series.skipped,
        overridden: [],
        calendarChecked: true,
        calendarQueued: series.calendarState === 'queued',
      };
    }
    const replacing = rows.filter((r) => live(r) && r.startMs > now && r.occurrenceStartMs >= pivotMs);
    const allowConflicts = args.allowConflicts === true;
    const skip = args.skipConflictingDates === true;
    const planned = await planSeries(db, {
      memberId: series.hostMemberId,
      anchor,
      rule,
      now,
      allowConflicts,
      skipConflictingDates: skip,
      calendar,
      replacing,
      replacingOnCalendar: !!series.calendarEventId,
    });
    if (!planned.ok) return planned;
    const { plan } = planned;
    if (series.calendarState !== 'queued' && !noDatesFrom(anchor, rule, plan.materializeToMs))
      return { ok: false, reason: 'INVALID', message: NEEDS_CALENDAR_TO_REPEAT };
    const targetId = whole ? series.id : randomUUID();
    const revision = whole ? series.revision + 1 : 0;
    const source: OccurrenceSource = {
      seriesId: targetId,
      revision,
      accountId: series.accountId,
      memberId: series.hostMemberId,
      title: series.title,
      description: series.description,
      locationKind: series.locationKind,
      timeZone: tz,
      attendees: series.attendees,
      calendar: series.calendarState === 'queued' ? 'queued' : 'not_connected',
      calendarChecked: plan.calendarChecked,
    };
    type Written =
      | { ok: true; written: Array<{ uid: string; startMs: number }>; skipped: SkippedDate[] }
      | { ok: false; reason: 'SLOT_TAKEN' | 'CONFLICT'; date: string }
      | typeof STALE;
    let result: Written;
    try {
      result = await lockedWrite<Written>(db, series.hostMemberId, function* () {
        if (!(yield* sameRevision(series.id, series.revision))) throw new Abort(STALE);
        // The dates being replaced first, so the new ones are checked against the rest.
        for (const r of replacing) {
          yield {
            run: sql`UPDATE booking SET status = 'cancelled', rescheduled = 1, cancelled_by = 'host', updated_at = ${now}
                WHERE id = ${r.id} AND status IN ('accepted','pending')`,
          };
        }
        const out = yield* writeOccurrences(db, source, plan.kept, { allowConflicts, skip, now, overridden: plan.overridden });
        if (out.written.length === 0) throw new Abort({ ok: false as const, reason: 'SLOT_TAKEN' as const, date: plan.kept[0]!.date });
        const skipped = [...plan.skipped, ...out.skipped].sort((a, b) => a.startMs - b.startMs);
        if (whole) {
          yield {
            run: sql`UPDATE host_event_series
                SET start_date = ${anchor.startDate}, start_time = ${anchor.startTime}, weekdays = ${rule.weekdays.join(',')},
                    occurrence_count = ${rule.count}, until_date = ${rule.untilDate}, skipped = ${jsonParam(db, skipped)},
                    materialized_until_ms = ${plan.materializeToMs}, status = 'active', revision = ${revision}, updated_at = ${now}
                WHERE id = ${series.id}`,
          };
        } else {
          yield {
            run: sql`UPDATE host_event_series
                SET occurrence_count = NULL, until_date = ${addCivilDays(pivotDate, -1)}, status = 'ended',
                    revision = ${series.revision + 1}, updated_at = ${now}
                WHERE id = ${series.id}`,
          };
          yield {
            run: sql`INSERT INTO host_event_series (id, account_id, host_member_id, title, description, location_kind,
                  time_zone, start_date, start_time, duration_minutes, frequency, interval_count, weekdays,
                  occurrence_count, until_date, attendees, status, materialized_until_ms, skipped, calendar_state,
                  calendar_destination, split_from, metadata, created_at, updated_at)
                VALUES (${targetId}, ${series.accountId}, ${series.hostMemberId}, ${series.title}, ${series.description},
                  ${series.locationKind}, ${tz}, ${anchor.startDate}, ${anchor.startTime}, ${anchor.durationMinutes},
                  ${rule.frequency}, ${rule.interval}, ${rule.weekdays.join(',')}, ${rule.count}, ${rule.untilDate},
                  ${jsonParam(db, series.attendees)}, 'active', ${plan.materializeToMs}, ${jsonParam(db, skipped)},
                  ${series.calendarState === 'queued' ? 'queued' : 'not_connected'}, ${series.calendarDestination},
                  ${series.id}, ${jsonParam(db, { _created: { firstUid: out.written[0]!.uid, occurrences: out.written.length, skipped, overridden: plan.overridden, calendarChecked: plan.calendarChecked } })},
                  ${now}, ${now})`,
          };
        }
        return { ok: true, written: out.written, skipped };
      });
    } catch (err) {
      if (!isExclusionViolation(err)) throw err;
      result = { ok: false, reason: 'SLOT_TAKEN', date: '' };
    }
    if (result === STALE) {
      if (attempt < 3) continue;
      throw new Error(`series ${series.id} kept changing while it was moved`);
    }
    if (!result.ok) return { ok: false, reason: result.reason, conflicts: [] };
    return {
      ok: true,
      seriesId: targetId,
      previousSeriesId: whole ? null : series.id,
      firstUid: result.written[0]!.uid,
      alreadyApplied: false,
      cancelled: replacing.map((r) => r.uid),
      occurrences: result.written.length,
      skipped: result.skipped,
      overridden: plan.overridden,
      calendarChecked: plan.calendarChecked,
      calendarQueued: series.calendarState === 'queued',
    };
  }
}

// --- The calendar event of a series (claimed like a booking's, DH1) ------------

/**
 * Claim the write of a series' calendar event: answers a token when this caller
 * may create it, null when it is already written or another write holds it.
 */
export async function claimSeriesCalendar(db: Db, seriesId: string): Promise<string | null> {
  const token = randomUUID();
  await db.run(
    sql`UPDATE host_event_series SET calendar_claim = ${token}
        WHERE id = ${seriesId} AND calendar_event_id IS NULL AND calendar_claim IS NULL`,
  );
  const row = await db.get<{ calendar_claim: string | null }>(
    sql`SELECT calendar_claim FROM host_event_series WHERE id = ${seriesId} LIMIT 1`,
  );
  return row?.calendar_claim === token ? token : null;
}

/** Record the series' calendar event once written (only by the claim's holder). */
export async function fillSeriesCalendar(
  db: Db,
  seriesId: string,
  token: string,
  ref: { externalEventId: string; externalCalendarId: string | null; meetingUrl: string | null; destination: string },
): Promise<void> {
  await db.run(
    sql`UPDATE host_event_series
        SET calendar_event_id = ${ref.externalEventId}, calendar_calendar_id = ${ref.externalCalendarId},
            meeting_url = COALESCE(${ref.meetingUrl}, meeting_url), calendar_destination = ${ref.destination},
            calendar_claim = NULL, updated_at = ${Date.now()}
        WHERE id = ${seriesId} AND calendar_claim = ${token}`,
  );
}

/** Drop a claim whose write failed, so a retry can write it. */
export async function releaseSeriesCalendar(db: Db, seriesId: string, token: string): Promise<void> {
  await db.run(sql`UPDATE host_event_series SET calendar_claim = NULL WHERE id = ${seriesId} AND calendar_claim = ${token}`);
}

/** Keep a room a calendar returned on a move (never blanks a stored one). */
export async function setSeriesMeetingUrl(db: Db, seriesId: string, meetingUrl: string): Promise<void> {
  await db.run(sql`UPDATE host_event_series SET meeting_url = ${meetingUrl}, updated_at = ${Date.now()} WHERE id = ${seriesId}`);
}

/** The series' calendar event was deleted. */
export async function markSeriesCalendarDeleted(db: Db, seriesId: string): Promise<void> {
  await db.run(sql`UPDATE host_event_series SET calendar_state = 'deleted', updated_at = ${Date.now()} WHERE id = ${seriesId}`);
}

/** The dates of a series' rule over a window, for the calendar's exclusions and answers. */
export function seriesDates(series: Pick<HostEventSeries, 'anchor' | 'rule'>, fromMs: number, toMs: number, max = 500): Occurrence[] {
  return seriesOccurrences(series.anchor, series.rule, { fromMs, toMs, max });
}

/** How a date of a series repeats, for the dashboard (its own words come from its catalog). */
export interface SeriesRepeats {
  seriesId: string;
  frequency: 'daily' | 'weekly';
  interval: number;
  weekdays: RecurrenceWeekday[];
  count: number | null;
  untilDate: string | null;
  startTime: string;
  timeZone: string;
  status: SeriesStatus;
}

/**
 * Which of these bookings are dates of a series, with how it repeats, within
 * the account. One read for a page of the dashboard's list.
 */
export async function loadSeriesRepeats(db: Db, accountId: string, uids: readonly string[]): Promise<Map<string, SeriesRepeats>> {
  const out = new Map<string, SeriesRepeats>();
  if (uids.length === 0) return out;
  const list = uids.map((u) => sql`${u}`).reduce((acc, cur) => sql`${acc}, ${cur}`);
  const rows = await db.all<SeriesRow & { booking_uid: string }>(
    sql`SELECT s.*, b.uid AS booking_uid FROM booking b JOIN host_event_series s ON s.id = b.recurring_event_id
        WHERE b.account_id = ${accountId} AND b.event_type_id IS NULL AND b.uid IN (${list})`,
  );
  for (const r of rows) {
    const series = seriesFromRow(r);
    out.set(r.booking_uid, {
      seriesId: series.id,
      frequency: series.rule.frequency,
      interval: series.rule.interval,
      weekdays: series.rule.weekdays,
      count: series.rule.count,
      untilDate: series.rule.untilDate,
      startTime: series.anchor.startTime,
      timeZone: series.anchor.timeZone,
      status: series.status,
    });
  }
  return out;
}
