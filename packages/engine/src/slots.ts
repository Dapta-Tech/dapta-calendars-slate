/**
 * Pure availability → slots computation (no DB, no I/O — fully unit-testable).
 *
 * Pipeline (API-CONTRACT §Engine rules 1):
 *   schedule wall-clock  --project per date in schedule.timeZone (DST-safe)-->
 *   available windows (UTC)  --step by slotInterval-->  candidate slots
 *   --drop any whose [start−beforeBuffer, end+afterBuffer] overlaps busy-->
 *   --drop before now+minimumBookingNotice, cap at the window (and at the
 *   booking window, N calendar days ahead)-->  free slots.
 *
 * `busy` is the UNION the caller assembles: vendor busy-times (all
 * check-conflict calendars of the qualified hosts) + existing `accepted`
 * bookings + active `slot_reservation` holds. Round-robin host SELECTION happens
 * after slot selection (see host-selector), so this layer is host-agnostic.
 */
import {
  WallClock,
  civilDateLte,
  civilDateString,
  civilWeekday,
  localDateParts,
  nextCivilDate,
  parseTimeOfDay,
  zonedWallClockToUtc,
} from './tz.util';

/** A wall-clock availability rule (mirrors booking.availability). */
export interface AvailabilityRule {
  /** 0=Sun..6=Sat for a recurring rule; null for a date override. */
  days: number[] | null;
  /** "HH:mm[:ss]" wall-clock in the schedule's timeZone. */
  startTime: string;
  endTime: string;
  /** "YYYY-MM-DD" for a date-specific override; null for recurring. */
  date: string | null;
}

/** A UTC busy interval to subtract. */
export interface Interval {
  start: Date;
  end: Date;
}

export interface ComputeSlotsInput {
  /** Window to search (UTC). The result is clipped to [fromUtc, toUtc). */
  fromUtc: Date;
  toUtc: Date;
  /** Schedule home IANA timeZone — the frame recurring wall-clock is read in. */
  timeZone: string;
  availability: AvailabilityRule[];
  /** Meeting length (minutes). */
  durationMin: number;
  /** Slot step (minutes). Defaults to durationMin when null/undefined. */
  slotIntervalMin?: number | null;
  busy: Interval[];
  beforeBufferMin?: number;
  afterBufferMin?: number;
  /** Earliest lead time (minutes from `now`). */
  minimumBookingNoticeMin?: number;
  /**
   * Latest booking: how many calendar days ahead of today, in `timeZone`, a
   * slot may start (see {@link bookingWindowEnd}). null or absent = no limit.
   */
  bookingWindowDays?: number | null;
  /** "Now" (UTC) — injected for deterministic tests. */
  now: Date;
}

const MINUTE_MS = 60_000;
/** The furthest a booking window is ever computed: a century of days (see `bookingWindowEnd`). */
const MAX_WINDOW_DAYS_COMPUTED = 36_500;

/**
 * The first instant past an event's booking window: the start of the calendar
 * day `days + 1` after today, both read in `timeZone`. Today is day 0, so a
 * 14-day window on Monday the 1st ends with Monday the 15th, whatever the
 * hour: the rolling "calendar days into the future" rule cal.com uses. A
 * midnight that a DST change skips starts its day at the transition
 * (`zonedWallClockToUtc`), so no slot of that day is lost. null when the event
 * has no window (`days` null or absent).
 */
export function bookingWindowEnd(now: Date, timeZone: string, days: number | null | undefined): Date | null {
  if (days === null || days === undefined || Number.isNaN(days)) return null;
  // The API takes 1..730. Bounded here as well, so a value written past it
  // (straight into the column) cannot build an Invalid Date and throw a
  // RangeError out of every slot read: below 0 is today only, and anything
  // past a century is as good as no limit.
  const span = Math.min(Math.max(Math.trunc(days), 0), MAX_WINDOW_DAYS_COMPUTED);
  const today = localDateParts(now, timeZone);
  // Civil arithmetic in UTC, where every day has 24 hours: month and year
  // rollover are Date's, and no zone offset can move the day.
  const end = new Date(Date.UTC(today.year, today.month - 1, today.day + span + 1));
  return zonedWallClockToUtc(
    { year: end.getUTCFullYear(), month: end.getUTCMonth() + 1, day: end.getUTCDate(), hour: 0, minute: 0 },
    timeZone,
  );
}

/**
 * Combine several hosts' free-slot instant sets for a team event.
 *
 *   - UNION (round_robin / the rotating pool of fixed_round_robin): a slot is
 *     offered if AT LEAST ONE host is free — the specific host is chosen at
 *     booking time.
 *   - INTERSECTION (collective): a slot is offered only if ALL hosts are free,
 *     because every host must attend.
 *
 * Both take pre-computed per-host instant sets (ms since epoch) and return a
 * sorted, de-duplicated ascending array — pure, so the DB layer stays a thin
 * assembler over {@link computeSlots} + these.
 */
export function unionInstants(perHost: Array<Set<number>>): number[] {
  const out = new Set<number>();
  for (const set of perHost) for (const ms of set) out.add(ms);
  return [...out].sort((a, b) => a - b);
}

export function intersectInstants(perHost: Array<Set<number>>): number[] {
  if (perHost.length === 0) return [];
  // Start from the smallest set and keep only instants present in every other.
  const [smallest, ...rest] = [...perHost].sort((a, b) => a.size - b.size);
  const out: number[] = [];
  for (const ms of smallest) {
    if (rest.every((s) => s.has(ms))) out.push(ms);
  }
  return out.sort((a, b) => a - b);
}

/** Merge overlapping/adjacent intervals (sorted by start) into a minimal set. */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.start.getTime() - b.start.getTime());
  const out: Interval[] = [{ start: sorted[0].start, end: sorted[0].end }];
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1];
    const cur = sorted[i];
    if (cur.start.getTime() <= last.end.getTime()) {
      if (cur.end.getTime() > last.end.getTime()) last.end = cur.end;
    } else {
      out.push({ start: cur.start, end: cur.end });
    }
  }
  return out;
}

/** True if [aStart,aEnd) overlaps any merged busy interval. */
function overlapsBusy(aStart: number, aEnd: number, busy: Interval[]): boolean {
  for (const b of busy) {
    const bs = b.start.getTime();
    const be = b.end.getTime();
    if (be <= aStart) continue; // busy entirely before → keep scanning
    if (bs >= aEnd) break; // busy starts after candidate (sorted) → no overlap
    return true;
  }
  return false;
}

/**
 * Compute free slot START instants (UTC), sorted ascending, de-duplicated.
 */
export function computeSlots(input: ComputeSlotsInput): Date[] {
  const {
    fromUtc,
    toUtc,
    timeZone,
    availability,
    durationMin,
    now,
    beforeBufferMin = 0,
    afterBufferMin = 0,
    minimumBookingNoticeMin = 0,
  } = input;

  const step =
    (input.slotIntervalMin && input.slotIntervalMin > 0 ? input.slotIntervalMin : durationMin) *
    MINUTE_MS;
  const durationMs = durationMin * MINUTE_MS;
  const beforeMs = beforeBufferMin * MINUTE_MS;
  const afterMs = afterBufferMin * MINUTE_MS;
  const earliest = Math.max(fromUtc.getTime(), now.getTime() + minimumBookingNoticeMin * MINUTE_MS);
  // The search window's end, pulled in to the booking window's when the event
  // has one: a slot at or past it is neither offered nor bookable, because
  // every hold, booking and reschedule check runs through here too.
  const bookingEnd = bookingWindowEnd(now, timeZone, input.bookingWindowDays);
  const windowEnd = bookingEnd ? Math.min(toUtc.getTime(), bookingEnd.getTime()) : toUtc.getTime();

  const busy = mergeIntervals(input.busy);

  // Split rules into date-overrides (keyed by date) and recurring (by weekday).
  const overridesByDate = new Map<string, AvailabilityRule[]>();
  const recurring: AvailabilityRule[] = [];
  for (const rule of availability) {
    if (rule.date) {
      const arr = overridesByDate.get(rule.date) ?? [];
      arr.push(rule);
      overridesByDate.set(rule.date, arr);
    } else if (rule.days && rule.days.length > 0) {
      recurring.push(rule);
    }
  }

  const results: number[] = [];
  const seen = new Set<number>();

  // Iterate civil dates in the schedule's zone from the local date of fromUtc
  // to the local date of toUtc (inclusive) — a block on the last local day can
  // still yield slots inside the UTC window.
  let civil: { year: number; month: number; day: number } = localDateParts(fromUtc, timeZone);
  const endCivil = localDateParts(toUtc, timeZone);

  // Guard against pathological windows (cap enforced by the caller at 60 days,
  // but keep the loop finite regardless).
  let safety = 0;
  while (civilDateLte(civil, endCivil) && safety++ < 400) {
    const dateStr = civilDateString(civil);
    const weekday = civilWeekday(civil);

    // A date override REPLACES recurring rules for that calendar date.
    const overrides = overridesByDate.get(dateStr);
    const rulesForDay = overrides ?? recurring.filter(r => r.days!.includes(weekday));

    for (const rule of rulesForDay) {
      const s = parseTimeOfDay(rule.startTime);
      const e = parseTimeOfDay(rule.endTime);
      // Both ends follow the same rule on a DST day: in a gap, the transition;
      // in an overlap, the first occurrence (see zonedWallClockToUtc).
      const blockStartWc: WallClock = { ...civil, hour: s.hour, minute: s.minute };
      const blockEndWc: WallClock = { ...civil, hour: e.hour, minute: e.minute };
      const blockStart = zonedWallClockToUtc(blockStartWc, timeZone).getTime();
      const blockEnd = zonedWallClockToUtc(blockEndWc, timeZone).getTime();
      if (blockEnd <= blockStart) continue;

      for (let slotStart = blockStart; slotStart + durationMs <= blockEnd; slotStart += step) {
        const slotEnd = slotStart + durationMs;
        if (slotStart < earliest) continue;
        if (slotStart >= windowEnd) break;
        // Buffer the candidate on both sides before testing against busy.
        if (overlapsBusy(slotStart - beforeMs, slotEnd + afterMs, busy)) continue;
        if (!seen.has(slotStart)) {
          seen.add(slotStart);
          results.push(slotStart);
        }
      }
    }

    civil = nextCivilDate(civil);
  }

  results.sort((a, b) => a - b);
  return results.map(ms => new Date(ms));
}
