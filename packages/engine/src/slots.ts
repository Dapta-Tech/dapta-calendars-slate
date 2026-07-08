/**
 * Pure availability → slots computation (no DB, no I/O — fully unit-testable).
 *
 * Pipeline (API-CONTRACT §Engine rules 1):
 *   schedule wall-clock  --project per date in schedule.timeZone (DST-safe)-->
 *   available windows (UTC)  --step by slotInterval-->  candidate slots
 *   --drop any whose [start−beforeBuffer, end+afterBuffer] overlaps busy-->
 *   --drop before now+minimumBookingNotice, cap at the window-->  free slots.
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
  /** "Now" (UTC) — injected for deterministic tests. */
  now: Date;
}

const MINUTE_MS = 60_000;

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
  const windowEnd = toUtc.getTime();

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
