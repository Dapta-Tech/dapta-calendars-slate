import { monthKeyOf, shiftMonth, zoneOffsetMinutes, zonedTodayKey } from '@slate/shared';
import { MAX_AVAILABILITY_WINDOW_MS } from '@slate/types';

/**
 * The windows a booking page reads its availability in.
 *
 * A page used to read the whole booking window (60 days) before it could
 * paint, and every day of that window is a calendar read the visitor waits
 * on. It now reads the month on screen first and the rest as the visitor
 * moves, so this file answers two questions: which instants a month covers,
 * and which of them the page already has.
 *
 * Everything here is in UTC milliseconds. A month is a span of instants in a
 * ZONE, so a time zone switch moves its edges by a few hours; tracking what has
 * been read as instants (not as month keys) is what lets a switch read only
 * the sliver it newly needs instead of the whole month again.
 */

/** A half-open span of instants, [fromMs, toMs). */
export interface Span {
  fromMs: number;
  toMs: number;
}

/** The furthest instant any booking page offers: the contract's window bound. */
export function bookingHorizonMs(nowMs: number): number {
  return nowMs + MAX_AVAILABILITY_WINDOW_MS;
}

/** The instant a calendar day ("2026-10-12") starts in `timeZone`. */
export function zonedDayStartMs(dayKey: string, timeZone: string): number {
  const [y, m, d] = dayKey.split('-').map(Number);
  const wall = Date.UTC(y!, m! - 1, d!);
  // Two passes: the offset at the wall time's UTC reading can differ from the
  // offset at the real instant across a DST change, and the second pass lands
  // on the right side of it.
  const first = wall - zoneOffsetMinutes(new Date(wall), timeZone) * 60_000;
  return wall - zoneOffsetMinutes(new Date(first), timeZone) * 60_000;
}

/** Every instant of a month ("2026-10") in `timeZone`. */
export function monthSpan(monthKey: string, timeZone: string): Span {
  return {
    fromMs: zonedDayStartMs(`${monthKey}-01`, timeZone),
    toMs: zonedDayStartMs(`${shiftMonth(monthKey, 1)}-01`, timeZone),
  };
}

/**
 * The part of a month a page can offer: from now (nothing before it is
 * bookable) to the booking horizon. `null` when the month lies wholly outside.
 */
export function monthWindow(monthKey: string, timeZone: string, nowMs: number, horizonMs: number): Span | null {
  const span = monthSpan(monthKey, timeZone);
  const fromMs = Math.max(span.fromMs, nowMs);
  const toMs = Math.min(span.toMs, horizonMs);
  return toMs > fromMs ? { fromMs, toMs } : null;
}

/** The month that holds today in `timeZone`. */
export function currentMonthKey(timeZone: string, nowMs: number): string {
  return monthKeyOf(zonedTodayKey(timeZone, new Date(nowMs)));
}

/** The month the horizon falls in, which is the last month a page can show. */
export function horizonMonthKey(timeZone: string, horizonMs: number): string {
  // The horizon is exclusive, so the last bookable instant is just before it.
  return monthKeyOf(zonedTodayKey(timeZone, new Date(horizonMs - 1)));
}

/** The widest gap between two zones' clocks: UTC-12 to UTC+14. */
const MAX_ZONE_SPREAD_MS = 26 * 60 * 60 * 1000;

/**
 * The window a page reads before anything else: the visible month, which is
 * the one holding today. The page opens in the visitor's zone, which the
 * server cannot know, so the read runs past the end of `timeZone`'s month by
 * the widest zone spread (within the horizon): a visitor west of the host
 * sees a month that ends later, and gets it whole from this one read.
 */
export function firstWindow(timeZone: string, nowMs: number): Span {
  const horizonMs = bookingHorizonMs(nowMs);
  const month = monthWindow(currentMonthKey(timeZone, nowMs), timeZone, nowMs, horizonMs);
  if (!month) return { fromMs: nowMs, toMs: horizonMs };
  return { fromMs: month.fromMs, toMs: Math.min(month.toMs + MAX_ZONE_SPREAD_MS, horizonMs) };
}

/** Union a span into a sorted, non-overlapping list of spans. */
export function addSpan(spans: readonly Span[], add: Span): Span[] {
  if (add.toMs <= add.fromMs) return [...spans];
  const all = [...spans, add].sort((a, b) => a.fromMs - b.fromMs);
  const out: Span[] = [];
  for (const s of all) {
    const last = out[out.length - 1];
    if (last && s.fromMs <= last.toMs) last.toMs = Math.max(last.toMs, s.toMs);
    else out.push({ ...s });
  }
  return out;
}

/** The pieces of `want` that `spans` do not cover, in order. */
export function missingSpans(spans: readonly Span[], want: Span): Span[] {
  const gaps: Span[] = [];
  let cursor = want.fromMs;
  for (const s of [...spans].sort((a, b) => a.fromMs - b.fromMs)) {
    if (s.toMs <= cursor) continue;
    if (s.fromMs >= want.toMs) break;
    if (s.fromMs > cursor) gaps.push({ fromMs: cursor, toMs: Math.min(s.fromMs, want.toMs) });
    cursor = Math.max(cursor, s.toMs);
    if (cursor >= want.toMs) break;
  }
  if (cursor < want.toMs) gaps.push({ fromMs: cursor, toMs: want.toMs });
  return gaps;
}

/** True when `spans` hold every instant of `want`. */
export function covers(spans: readonly Span[], want: Span): boolean {
  return missingSpans(spans, want).length === 0;
}
