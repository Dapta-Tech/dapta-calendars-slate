import { describe, expect, it } from 'vitest';
import { MAX_AVAILABILITY_WINDOW_MS } from '@slate/types';
import {
  addSpan,
  bookingHorizonMs,
  covers,
  currentMonthKey,
  firstWindow,
  horizonMonthKey,
  missingSpans,
  monthSpan,
  monthWindow,
  zonedDayStartMs,
} from './availability-window';

const NY = 'America/New_York';
const at = (iso: string) => Date.parse(iso);

describe('the windows a booking page reads', () => {
  it('a day starts at local midnight, on both sides of a clock change', () => {
    expect(zonedDayStartMs('2026-10-12', NY)).toBe(at('2026-10-12T04:00:00.000Z'));
    expect(zonedDayStartMs('2026-12-01', NY)).toBe(at('2026-12-01T05:00:00.000Z'));
    // The day the clocks go back is 25 hours long, and still starts at midnight.
    expect(zonedDayStartMs('2026-11-01', NY)).toBe(at('2026-11-01T04:00:00.000Z'));
    expect(zonedDayStartMs('2026-11-02', NY)).toBe(at('2026-11-02T05:00:00.000Z'));
  });

  it('a month is every instant from its first midnight to the next month first midnight', () => {
    expect(monthSpan('2026-11', NY)).toEqual({
      fromMs: at('2026-11-01T04:00:00.000Z'),
      toMs: at('2026-12-01T05:00:00.000Z'),
    });
    expect(monthSpan('2026-12', 'Asia/Tokyo')).toEqual({
      fromMs: at('2026-11-30T15:00:00.000Z'),
      toMs: at('2026-12-31T15:00:00.000Z'),
    });
  });

  it('the first read is the visible month: from now to its end, never the whole window', () => {
    const now = at('2026-10-12T15:30:00.000Z');
    const w = firstWindow(NY, now);
    expect(w).toEqual({ fromMs: now, toMs: at('2026-11-01T04:00:00.000Z') });
    expect(w.toMs - w.fromMs).toBeLessThan(MAX_AVAILABILITY_WINDOW_MS);
  });

  it('a month is clipped to now and to the booking horizon, and is nothing outside them', () => {
    const now = at('2026-10-12T15:30:00.000Z');
    const horizon = bookingHorizonMs(now);
    expect(horizon - now).toBe(MAX_AVAILABILITY_WINDOW_MS);
    expect(monthWindow('2026-12', NY, now, horizon)).toEqual({
      fromMs: at('2026-12-01T05:00:00.000Z'),
      toMs: horizon,
    });
    expect(monthWindow('2026-09', NY, now, horizon)).toBeNull();
    expect(monthWindow('2027-01', NY, now, horizon)).toBeNull();
  });

  it('today and the horizon name the first and last month a visitor can see', () => {
    const now = at('2026-10-12T15:30:00.000Z');
    expect(currentMonthKey(NY, now)).toBe('2026-10');
    expect(horizonMonthKey(NY, bookingHorizonMs(now))).toBe('2026-12');
    // Late on the 31st in New York is already the 1st in Tokyo.
    const lateOct31 = at('2026-10-31T23:00:00.000Z');
    expect(currentMonthKey(NY, lateOct31)).toBe('2026-10');
    expect(currentMonthKey('Asia/Tokyo', lateOct31)).toBe('2026-11');
  });
});

describe('what the page already has', () => {
  const s = (a: number, b: number) => ({ fromMs: a, toMs: b });

  it('spans union into a sorted list with no overlap', () => {
    let spans = addSpan([], s(10, 20));
    spans = addSpan(spans, s(30, 40));
    spans = addSpan(spans, s(20, 30));
    expect(spans).toEqual([s(10, 40)]);
    expect(addSpan([s(10, 20)], s(50, 60))).toEqual([s(10, 20), s(50, 60)]);
    expect(addSpan([s(10, 20)], s(15, 15))).toEqual([s(10, 20)]);
  });

  it('only the gaps are read again, so a time zone switch reads a sliver, not a month', () => {
    expect(missingSpans([s(10, 20), s(30, 40)], s(0, 50))).toEqual([s(0, 10), s(20, 30), s(40, 50)]);
    expect(missingSpans([s(0, 100)], s(10, 20))).toEqual([]);
    expect(missingSpans([], s(10, 20))).toEqual([s(10, 20)]);
    const oct = monthSpan('2026-10', NY);
    const octTokyo = monthSpan('2026-10', 'Asia/Tokyo');
    const gaps = missingSpans([oct], octTokyo);
    expect(gaps).toEqual([{ fromMs: octTokyo.fromMs, toMs: oct.fromMs }]);
    expect(gaps[0]!.toMs - gaps[0]!.fromMs).toBe(13 * 3_600_000);
  });

  it('a month is known only when every instant of it is', () => {
    expect(covers([s(0, 100)], s(10, 20))).toBe(true);
    expect(covers([s(0, 15), s(15, 30)], s(10, 20))).toBe(true);
    expect(covers([s(0, 15), s(16, 30)], s(10, 20))).toBe(false);
  });
});
