/**
 * Booking limits per event type: how many bookings, and how many minutes of
 * them, one day and one week may hold. Pure: the caller hands over the event's
 * live bookings (which statuses count is the DB's half) and the zone days are
 * read in: a personal event's schedule zone, a team event's team zone.
 *
 * A booking counts on the day and the week its START falls on in that zone,
 * all of its minutes included, even past midnight; a week runs Monday 00:00 to
 * Sunday 24:00 (ISO). A time is offered only while one more booking of its
 * length keeps every limit of its day and its week.
 */
import type { Interval } from './slots';
import { civilDateString, civilWeekday, localDateParts } from './tz.util';

/** An event type's limits. null or absent: no limit on that measure. */
export interface BookingLimits {
  maxBookingsPerDay?: number | null;
  maxBookingsPerWeek?: number | null;
  maxMinutesPerDay?: number | null;
  maxMinutesPerWeek?: number | null;
}

/** What `computeSlots` needs to apply an event's limits. */
export interface BookingLimitsInput {
  limits: BookingLimits;
  /** The event type's bookings that count (accepted or pending), around the window. */
  booked: Interval[];
  /**
   * A seated event (seats > 1): a time that already holds one of `booked`
   * takes another seat, not another booking, so the limits never close it.
   */
  seated?: boolean;
  /**
   * The zone days and weeks are read in, when it is not the zone of the times
   * being offered. A team event reads its limits in the team's zone, one zone
   * for all its hosts, since the limit is the event's as a whole. Absent: the
   * slots' own zone (a personal event's schedule).
   */
  timeZone?: string;
}

/** Which limit a time would break: its day's or its week's. */
export type BookingLimitPeriod = 'day' | 'week';

const MINUTE_MS = 60_000;
const MEASURES = ['maxBookingsPerDay', 'maxBookingsPerWeek', 'maxMinutesPerDay', 'maxMinutesPerWeek'] as const;

/** True when at least one limit is set (a positive number). */
export function hasBookingLimits(limits: BookingLimits | null | undefined): limits is BookingLimits {
  return !!limits && MEASURES.some((k) => typeof limits[k] === 'number' && limits[k]! > 0);
}

/**
 * The day and the week an instant falls on in `timeZone`, as "YYYY-MM-DD"
 * keys (the week by its Monday). The civil date comes from the zone, so a DST
 * change, even one that skips midnight, never moves an instant to another day.
 */
export function bookingLimitPeriods(instant: Date, timeZone: string): { day: string; week: string } {
  const civil = localDateParts(instant, timeZone);
  const sinceMonday = (civilWeekday(civil) + 6) % 7;
  const monday = new Date(Date.UTC(civil.year, civil.month - 1, civil.day - sinceMonday));
  return {
    day: civilDateString(civil),
    week: civilDateString({ year: monday.getUTCFullYear(), month: monday.getUTCMonth() + 1, day: monday.getUTCDate() }),
  };
}

/**
 * A reusable check over one event's bookings: `breach(startMs, durationMs)`
 * answers which limit a booking there would break ('day' first, then 'week'),
 * or null when it keeps every one. Read in `input.timeZone`, else `timeZone`.
 * Built once per slot read, so a month of times tallies the bookings once.
 */
export function bookingLimitTally(
  input: BookingLimitsInput,
  slotZone: string,
): (startMs: number, durationMs: number) => BookingLimitPeriod | null {
  const { limits } = input;
  const timeZone = input.timeZone ?? slotZone;
  const days = new Map<string, { n: number; ms: number }>();
  const weeks = new Map<string, { n: number; ms: number }>();
  const add = (map: typeof days, key: string, ms: number) => {
    const t = map.get(key) ?? { n: 0, ms: 0 };
    map.set(key, { n: t.n + 1, ms: t.ms + ms });
  };
  for (const b of input.booked) {
    const p = bookingLimitPeriods(b.start, timeZone);
    const ms = Math.max(0, b.end.getTime() - b.start.getTime());
    add(days, p.day, ms);
    add(weeks, p.week, ms);
  }
  const starts = input.seated ? new Set(input.booked.map((b) => b.start.getTime())) : null;
  // A value the API never takes (0, negative) reads as no limit, as it does in
  // `hasBookingLimits`, so a raw write cannot close every day.
  const cap = (v: number | null | undefined) => (typeof v === 'number' && v > 0 ? v : null);
  const within = (t: { n: number; ms: number } | undefined, maxN: number | null | undefined, maxMin: number | null | undefined, ms: number) => {
    const n = cap(maxN);
    const min = cap(maxMin);
    return (n === null || (t?.n ?? 0) + 1 <= n) && (min === null || (t?.ms ?? 0) + ms <= min * MINUTE_MS);
  };
  return (startMs, durationMs) => {
    if (starts?.has(startMs)) return null;
    const p = bookingLimitPeriods(new Date(startMs), timeZone);
    if (!within(days.get(p.day), limits.maxBookingsPerDay, limits.maxMinutesPerDay, durationMs)) return 'day';
    if (!within(weeks.get(p.week), limits.maxBookingsPerWeek, limits.maxMinutesPerWeek, durationMs)) return 'week';
    return null;
  };
}

/**
 * Which limit one booking at `startMs` lasting `durationMin` would break, or
 * null when it keeps every one: what the locked write asks of the bookings it
 * just read again, and what a refusal names. `slotZone` as in `bookingLimitTally`.
 */
export function bookingLimitBreach(
  input: BookingLimitsInput,
  slotZone: string,
  startMs: number,
  durationMin: number,
): BookingLimitPeriod | null {
  if (!hasBookingLimits(input.limits)) return null;
  return bookingLimitTally(input, slotZone)(startMs, durationMin * MINUTE_MS);
}
