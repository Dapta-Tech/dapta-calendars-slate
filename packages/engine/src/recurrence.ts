/**
 * Repeating host events (ADR 0012): the pure rule a series follows, the dates it
 * falls on, and the RFC 5545 rule a calendar is given for it. No I/O.
 *
 * A series is anchored to a WALL CLOCK in one time zone: the first date, a local
 * start time and a length. Every occurrence starts at that local time on its own
 * date, whatever the UTC offset is that day, so a weekly 15:30 stays at 15:30
 * across a DST change, as the calendar that holds the series shows it. A local
 * time a DST change skips is read with the offset before the gap (RFC 5545,
 * 3.3.5), the reading calendar providers use, so dCal blocks the same
 * instant the calendar shows; a time that happens twice is its first reading.
 */
import { civilDateString, tzOffsetMs, zonedWallClockToUtc } from './tz.util';

export type RecurrenceFrequency = 'daily' | 'weekly';

/** Days of the week, Monday first (the week RFC 5545 starts by default). */
export const RECURRENCE_WEEKDAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;
export type RecurrenceWeekday = (typeof RECURRENCE_WEEKDAYS)[number];

/** RFC 5545 BYDAY codes, in the order of {@link RECURRENCE_WEEKDAYS}. */
const BYDAY = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;

export interface RecurrenceRule {
  frequency: RecurrenceFrequency;
  /** Every `interval` days or weeks; 1 is every day or every week. */
  interval: number;
  /** Weekly: the days it falls on (at least one). Daily: empty. */
  weekdays: RecurrenceWeekday[];
  /** How many occurrences in all, the first one included; null for no count. */
  count: number | null;
  /** The last date it may fall on (YYYY-MM-DD, inclusive, in the series' zone); null for none. */
  untilDate: string | null;
}

/** Where a series starts: its first date and the wall clock every occurrence keeps. */
export interface SeriesAnchor {
  /** The first occurrence's date, YYYY-MM-DD in `timeZone`. */
  startDate: string;
  /** The local start time, HH:mm, kept on every date. */
  startTime: string;
  durationMinutes: number;
  /** IANA zone the wall clock is read in. */
  timeZone: string;
}

export interface Occurrence {
  /** Position in the series, 0 for the first; counts every date the rule gives. */
  index: number;
  /** YYYY-MM-DD in the series' zone. */
  date: string;
  startMs: number;
  endMs: number;
}

const DAY_MS = 86_400_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

interface Civil {
  year: number;
  month: number;
  day: number;
}

function parseDate(s: string): Civil | null {
  const m = DATE_RE.exec(s);
  if (!m) return null;
  const c = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  const d = new Date(Date.UTC(c.year, c.month - 1, c.day));
  if (d.getUTCFullYear() !== c.year || d.getUTCMonth() !== c.month - 1 || d.getUTCDate() !== c.day) return null;
  return c;
}

/** Days since 1970-01-01 of a civil date (DST-free arithmetic on dates). */
function dayNumber(c: Civil): number {
  return Math.round(Date.UTC(c.year, c.month - 1, c.day) / DAY_MS);
}

function fromDayNumber(n: number): Civil {
  const d = new Date(n * DAY_MS);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}


/** 0 = Monday .. 6 = Sunday. */
function isoWeekdayIndex(dayNum: number): number {
  // 1970-01-01 was a Thursday (index 3).
  return (((dayNum + 3) % 7) + 7) % 7;
}

/** The weekday of a YYYY-MM-DD date. */
export function weekdayOf(date: string): RecurrenceWeekday {
  const c = parseDate(date);
  if (!c) throw new RangeError(`not a date: ${date}`);
  return RECURRENCE_WEEKDAYS[isoWeekdayIndex(dayNumber(c))]!;
}

/** Whole days from date `a` to date `b` (negative when b is earlier). */
export function civilDayDiff(a: string, b: string): number {
  const ca = parseDate(a);
  const cb = parseDate(b);
  if (!ca || !cb) throw new RangeError('not a date');
  return dayNumber(cb) - dayNumber(ca);
}

/** A date `days` later (or earlier, negative). */
export function addCivilDays(date: string, days: number): string {
  const c = parseDate(date);
  if (!c) throw new RangeError(`not a date: ${date}`);
  return civilDateString(fromDayNumber(dayNumber(c) + days));
}

/** The weekdays moved by `days` (a series moved from Wednesday to Thursday moves every day it falls on). */
export function shiftWeekdays(weekdays: readonly RecurrenceWeekday[], days: number): RecurrenceWeekday[] {
  const out = weekdays.map((w) => RECURRENCE_WEEKDAYS[(((RECURRENCE_WEEKDAYS.indexOf(w) + days) % 7) + 7) % 7]!);
  return sortWeekdays(out);
}

/** Monday first, each day once. */
export function sortWeekdays(weekdays: readonly RecurrenceWeekday[]): RecurrenceWeekday[] {
  return [...new Set(weekdays)].sort((a, b) => RECURRENCE_WEEKDAYS.indexOf(a) - RECURRENCE_WEEKDAYS.indexOf(b));
}

/**
 * The instant of a wall-clock time in `timeZone`, read the way a calendar reads
 * a repeating event's local time (RFC 5545, 3.3.5): a time that happens twice
 * is its first reading; a time a DST change skips keeps the offset from before
 * the gap, which puts it as far past the change as it was meant to be past the
 * hour (02:30 on a day that jumps from 02:00 to 03:00 is 03:30).
 */
export function seriesWallClockToUtc(
  wc: { year: number; month: number; day: number; hour: number; minute: number },
  timeZone: string,
): Date {
  const naive = Date.UTC(wc.year, wc.month - 1, wc.day, wc.hour, wc.minute, 0);
  const instant = zonedWallClockToUtc(wc, timeZone);
  // A real reading shows the same wall clock back.
  if (naive - tzOffsetMs(instant, timeZone) === instant.getTime()) return instant;
  return new Date(naive - tzOffsetMs(new Date(naive - DAY_MS), timeZone));
}

/** The smallest gap, in days, between two consecutive dates of the rule. */
function smallestGapDays(rule: RecurrenceRule): number {
  if (rule.frequency === 'daily') return rule.interval;
  const idx = sortWeekdays(rule.weekdays).map((w) => RECURRENCE_WEEKDAYS.indexOf(w));
  if (idx.length === 1) return 7 * rule.interval;
  let gap = Number.POSITIVE_INFINITY;
  for (let i = 1; i < idx.length; i++) gap = Math.min(gap, idx[i]! - idx[i - 1]!);
  // From the last day of one active week to the first day of the next active one.
  gap = Math.min(gap, 7 * rule.interval - idx[idx.length - 1]! + idx[0]!);
  return gap;
}

/** The longest an occurrence may last: shorter than the smallest gap by an hour, so no DST day lets two touch. */
export function maxOccurrenceMinutes(rule: RecurrenceRule): number {
  return smallestGapDays(rule) * 1440 - 60;
}

/**
 * Why a series is not valid, or null when it is. Checked before anything is
 * stored: a calendar would expand a rule like this one, so dCal must agree with
 * it date for date.
 */
export function recurrenceProblem(anchor: SeriesAnchor, rule: RecurrenceRule): string | null {
  if (!parseDate(anchor.startDate)) return 'The start date is not a valid date.';
  if (!TIME_RE.test(anchor.startTime)) return 'The start time is not a valid HH:mm time.';
  if (!Number.isInteger(rule.interval) || rule.interval < 1 || rule.interval > 52)
    return 'interval must be a whole number from 1 to 52.';
  if (rule.frequency === 'weekly') {
    if (rule.weekdays.length === 0) return 'A weekly series needs at least one weekday.';
    if (rule.weekdays.some((w) => !RECURRENCE_WEEKDAYS.includes(w))) return 'Unknown weekday.';
    if (!rule.weekdays.includes(weekdayOf(anchor.startDate)))
      return `The first date (${anchor.startDate}, a ${weekdayOf(anchor.startDate)}) is not one of the weekdays given.`;
  } else if (rule.frequency === 'daily') {
    if (rule.weekdays.length > 0) return 'weekdays applies only to a weekly series.';
  } else {
    return 'frequency must be daily or weekly.';
  }
  if (rule.count !== null && rule.untilDate !== null) return 'Give count or until, not both.';
  if (rule.count !== null && (!Number.isInteger(rule.count) || rule.count < 1)) return 'count must be at least 1.';
  if (rule.untilDate !== null) {
    if (!parseDate(rule.untilDate)) return 'until is not a valid date.';
    if (civilDayDiff(anchor.startDate, rule.untilDate) < 0) return 'until is before the first date.';
  }
  if (!Number.isInteger(anchor.durationMinutes) || anchor.durationMinutes < 1) return 'The length must be at least a minute.';
  if (anchor.durationMinutes > maxOccurrenceMinutes(rule))
    return 'Each occurrence would run into the next one: make it shorter or the dates further apart.';
  return null;
}

/**
 * The occurrences of a series whose START is in [fromMs, toMs), in order, at
 * most `max` of them. `index` counts every date the rule gives from the first,
 * so a count is honoured however late the window starts.
 */
export function seriesOccurrences(
  anchor: SeriesAnchor,
  rule: RecurrenceRule,
  window: { fromMs?: number; toMs: number; max?: number },
): Occurrence[] {
  const start = parseDate(anchor.startDate);
  if (!start) throw new RangeError(`not a date: ${anchor.startDate}`);
  const [hour, minute] = anchor.startTime.split(':').map(Number) as [number, number];
  const fromMs = window.fromMs ?? Number.NEGATIVE_INFINITY;
  const max = window.max ?? Number.POSITIVE_INFINITY;
  const until = rule.untilDate ? parseDate(rule.untilDate) : null;
  const untilDay = until ? dayNumber(until) : Number.POSITIVE_INFINITY;
  const startDay = dayNumber(start);
  // Weekly weeks are counted from the Monday of the first date's week (WKST=MO).
  const weekZero = startDay - isoWeekdayIndex(startDay);
  const days = new Set(rule.weekdays.map((w) => RECURRENCE_WEEKDAYS.indexOf(w)).filter((i) => i >= 0));
  // A rule that can give no date (a weekly one with no weekdays, a bad interval) gives none, at once.
  if ((rule.frequency === 'weekly' && days.size === 0) || !(rule.interval >= 1)) return [];
  const out: Occurrence[] = [];
  let index = 0;
  // The last day worth looking at: a day past the window's end in any zone.
  const lastDay = Math.floor(window.toMs / DAY_MS) + 2;
  for (let day = startDay; day <= Math.min(untilDay, lastDay); day++) {
    const matches =
      rule.frequency === 'daily'
        ? (day - startDay) % rule.interval === 0
        : days.has(isoWeekdayIndex(day)) && Math.floor((day - weekZero) / 7) % rule.interval === 0;
    if (!matches) continue;
    if (rule.count !== null && index >= rule.count) break;
    const c = fromDayNumber(day);
    const startMs = seriesWallClockToUtc({ ...c, hour, minute }, anchor.timeZone).getTime();
    const thisIndex = index++;
    if (startMs >= window.toMs) break;
    if (startMs < fromMs) continue;
    out.push({ index: thisIndex, date: civilDateString(c), startMs, endMs: startMs + anchor.durationMinutes * 60_000 });
    if (out.length >= max) break;
  }
  return out;
}

/** True when the series has no last date: no count and no until. */
export function isOpenEnded(rule: RecurrenceRule): boolean {
  return rule.count === null && rule.untilDate === null;
}

/**
 * The UTC instant that ends `untilDate` in the series' zone, in RFC 5545 basic
 * form (20271231T235959Z): what a calendar's UNTIL takes for an event with a
 * time zone. Null without an until.
 */
export function untilUtcFor(anchor: SeriesAnchor, rule: RecurrenceRule): string | null {
  if (!rule.untilDate) return null;
  const c = parseDate(rule.untilDate);
  if (!c) throw new RangeError(`not a date: ${rule.untilDate}`);
  const next = fromDayNumber(dayNumber(c) + 1);
  const endMs = seriesWallClockToUtc({ ...next, hour: 0, minute: 0 }, anchor.timeZone).getTime() - 1000;
  return basicUtc(endMs);
}

/** 2027-12-31T23:59:59.000Z → 20271231T235959Z. */
export function basicUtc(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * The series as an RFC 5545 RRULE value (without the `RRULE:` prefix), for a
 * calendar that takes one: FREQ=WEEKLY;INTERVAL=1;WKST=MO;BYDAY=WE;COUNT=10.
 */
export function rruleFor(anchor: SeriesAnchor, rule: RecurrenceRule): string {
  const parts = [`FREQ=${rule.frequency === 'daily' ? 'DAILY' : 'WEEKLY'}`, `INTERVAL=${rule.interval}`];
  if (rule.frequency === 'weekly') {
    parts.push('WKST=MO');
    parts.push(`BYDAY=${sortWeekdays(rule.weekdays).map((w) => BYDAY[RECURRENCE_WEEKDAYS.indexOf(w)]).join(',')}`);
  }
  if (rule.count !== null) parts.push(`COUNT=${rule.count}`);
  const until = untilUtcFor(anchor, rule);
  if (until) parts.push(`UNTIL=${until}`);
  return parts.join(';');
}

/**
 * The rule for what is left of a series from the occurrence at `index` on, when
 * it continues as a new series (a move of "this and following"): a count keeps
 * only the occurrences not yet used, and an until is kept.
 */
export function remainderRule(rule: RecurrenceRule, index: number): RecurrenceRule {
  return { ...rule, count: rule.count === null ? null : Math.max(1, rule.count - index) };
}

/** The rule ended the day before `date`: what is left of a series cut there. */
export function endedBefore(rule: RecurrenceRule, date: string): RecurrenceRule {
  return { ...rule, count: null, untilDate: addCivilDays(date, -1) };
}
