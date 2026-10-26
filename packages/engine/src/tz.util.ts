/**
 * Timezone projection utilities — dependency-free (uses the platform `Intl`
 * timezone database), so recurring wall-clock availability projects to correct
 * UTC instants across DST boundaries WITHOUT storing offsets (schema-design.md
 * §6). No luxon/date-fns-tz dependency added.
 *
 * The core trick: to place a wall-clock time in a zone onto the UTC line we
 * read the zone's offsets a day either side of it via `Intl.DateTimeFormat`,
 * try the time under each, and keep the reading the zone agrees with. Near a
 * DST transition that tells a time that happens once from one that happens
 * twice (a fall-back overlap) or never (a spring-forward gap).
 */

/** Civil (zone-less) calendar date + time. `month` is 1-12, `day` 1-31. */
export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const PARTS_FORMAT_CACHE = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = PARTS_FORMAT_CACHE.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    PARTS_FORMAT_CACHE.set(timeZone, f);
  }
  return f;
}

/** The zone's UTC offset (ms, = local − utc) at a given instant. */
export function tzOffsetMs(instant: Date, timeZone: string): number {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const map: Record<string, number> = {};
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = Number(p.value);
  }
  // `h23` renders midnight as 00 (not 24), so this is safe.
  const asUtcMs = Date.UTC(map.year, map.month - 1, map.day, map.hour, map.minute, map.second);
  return asUtcMs - instant.getTime();
}

const DAY_MS = 86_400_000;

/**
 * The UTC instant of a wall-clock time in `timeZone`. Correct across DST on
 * either side of UTC, and deterministic: a time in a fall-back overlap (it
 * happens twice) resolves to its first occurrence, and a time in a
 * spring-forward gap (it never happens) resolves forward to the first valid
 * instant after the gap, the transition itself. So a Sunday that starts at
 * 00:00 in America/Santiago starts at 01:00 on the day the clocks skip from
 * 00:00 to 01:00, never at 23:00 the evening before. The gap rule is on
 * purpose, unlike java.time or Temporal's "compatible" (which move 02:30 to
 * 03:30): a block that ends inside a gap then ends where the hours before it
 * end, not past them.
 */
export function zonedWallClockToUtc(wc: WallClock, timeZone: string): Date {
  const naiveUtcMs = Date.UTC(wc.year, wc.month - 1, wc.day, wc.hour, wc.minute, 0);
  // The zone's offsets a day either side bracket any transition near the time.
  const offA = tzOffsetMs(new Date(naiveUtcMs - DAY_MS), timeZone);
  const offB = tzOffsetMs(new Date(naiveUtcMs + DAY_MS), timeZone);
  // No transition within a day either side: the one offset is the answer.
  if (offA === offB) return new Date(naiveUtcMs - offA);
  const early = naiveUtcMs - Math.max(offA, offB);
  const late = naiveUtcMs - Math.min(offA, offB);
  // A reading is real when the zone's offset at that instant is the one used.
  // Early first: the only occurrence, or in an overlap the first.
  if (naiveUtcMs - tzOffsetMs(new Date(early), timeZone) === early) return new Date(early);
  const offLate = tzOffsetMs(new Date(late), timeZone);
  if (naiveUtcMs - offLate === late) return new Date(late);
  // Neither is real: the time is inside a spring-forward gap, and the
  // transition lies between the two readings (early is still on the old
  // offset, late already on offLate, the new one). Find it to the second:
  // transitions and offsets fall on whole seconds, so both readings do too.
  let lo = early;
  let hi = late;
  while (hi - lo > 1000) {
    // At least a second forward, so the loop ends whatever the gap's length.
    const mid = lo + Math.max(1000, Math.floor((hi - lo) / 2000) * 1000);
    if (tzOffsetMs(new Date(mid), timeZone) === offLate) hi = mid;
    else lo = mid;
  }
  return new Date(hi);
}

/** The civil Y-M-D (and weekday 0=Sun..6=Sat) of an instant, seen in `timeZone`. */
export function localDateParts(
  instant: Date,
  timeZone: string,
): { year: number; month: number; day: number; weekday: number } {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const map: Record<string, number> = {};
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = Number(p.value);
  }
  // Weekday: derive from the civil date (offset-independent). Date.UTC on the
  // civil Y-M-D gives a stable day-of-week regardless of zone.
  const weekday = new Date(Date.UTC(map.year, map.month - 1, map.day)).getUTCDay();
  return { year: map.year, month: map.month, day: map.day, weekday };
}

/** Parse "HH:mm" or "HH:mm:ss" wall-clock into hour/minute. */
export function parseTimeOfDay(t: string): { hour: number; minute: number } {
  const [h, m] = t.split(':');
  return { hour: Number(h), minute: Number(m) };
}

/** Civil-date helpers: increment a Y-M-D by one calendar day (DST-independent). */
export function nextCivilDate(d: { year: number; month: number; day: number }): {
  year: number;
  month: number;
  day: number;
} {
  const dt = new Date(Date.UTC(d.year, d.month - 1, d.day));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return { year: dt.getUTCFullYear(), month: dt.getUTCMonth() + 1, day: dt.getUTCDate() };
}

/** Compare two civil dates (ignoring time). */
export function civilDateLte(
  a: { year: number; month: number; day: number },
  b: { year: number; month: number; day: number },
): boolean {
  if (a.year !== b.year) return a.year < b.year;
  if (a.month !== b.month) return a.month < b.month;
  return a.day <= b.day;
}

/** The day-of-week (0=Sun..6=Sat) of a civil date. */
export function civilWeekday(d: { year: number; month: number; day: number }): number {
  return new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
}

/** Format a civil date as "YYYY-MM-DD" (matches a Postgres `date` column). */
export function civilDateString(d: { year: number; month: number; day: number }): string {
  const mm = String(d.month).padStart(2, '0');
  const dd = String(d.day).padStart(2, '0');
  return `${d.year}-${mm}-${dd}`;
}
