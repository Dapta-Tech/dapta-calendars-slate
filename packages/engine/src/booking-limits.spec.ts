import { describe, expect, it } from 'vitest';
import { computeSlots, computeSlotsDetailed, type AvailabilityRule, type Interval } from './slots';
import { bookingLimitBreach, type BookingLimits } from './booking-limits';
import { localDateParts } from './tz.util';

/**
 * Booking limits per event type: a time is offered only while one more booking
 * of its length keeps every limit of its day and its week (Monday to Sunday),
 * both read in the schedule's zone. The caller hands over the event's live
 * bookings; which statuses count (accepted and pending) is the DB's half.
 */
const NY = 'America/New_York';
const everyDay: AvailabilityRule = { days: [0, 1, 2, 3, 4, 5, 6], startTime: '09:00', endTime: '12:00', date: null };
const booking = (startIso: string, minutes = 30): Interval => ({
  start: new Date(startIso),
  end: new Date(Date.parse(startIso) + minutes * 60_000),
});
const dayIn = (d: Date, tz: string) => {
  const p = localDateParts(d, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
};
/** Times offered per local day, e.g. { '2026-03-04': 6 }. */
const perDay = (slots: Date[], tz: string) =>
  slots.reduce<Record<string, number>>((acc, d) => ({ ...acc, [dayIn(d, tz)]: (acc[dayIn(d, tz)] ?? 0) + 1 }), {});

function offered(limits: BookingLimits, booked: Interval[], o: { tz?: string; from?: string; to?: string; seated?: boolean } = {}) {
  const tz = o.tz ?? NY;
  return perDay(
    computeSlots({
      fromUtc: new Date(o.from ?? '2026-03-02T05:00:00Z'),
      toUtc: new Date(o.to ?? '2026-03-10T04:00:00Z'),
      timeZone: tz,
      availability: [everyDay],
      durationMin: 30,
      busy: [],
      now: new Date('2026-02-01T00:00:00Z'),
      bookingLimits: { limits, booked, seated: o.seated },
    }),
    tz,
  );
}

describe('booking limits in computeSlots', () => {
  it('a day limit closes that day only, once it is reached', () => {
    // Wednesday March 4 (EST): 10:00 and 11:00.
    const two = [booking('2026-03-04T15:00:00Z'), booking('2026-03-04T16:00:00Z')];
    expect(offered({ maxBookingsPerDay: 2 }, two)['2026-03-04']).toBeUndefined();
    expect(offered({ maxBookingsPerDay: 2 }, two)['2026-03-05']).toBe(6);
    expect(offered({ maxBookingsPerDay: 2 }, two.slice(1))['2026-03-04']).toBe(6);
    // Null (no limit) on every measure changes nothing.
    expect(offered({ maxBookingsPerDay: null, maxMinutesPerWeek: null }, two)['2026-03-04']).toBe(6);
  });

  it('minutes per day count the booked length plus the new one', () => {
    expect(offered({ maxMinutesPerDay: 60 }, [booking('2026-03-04T15:00:00Z', 45)])['2026-03-04']).toBeUndefined();
    expect(offered({ maxMinutesPerDay: 60 }, [booking('2026-03-04T15:00:00Z', 30)])['2026-03-04']).toBe(6);
  });

  it('a week runs Monday to Sunday in the schedule zone, and the next Monday opens again', () => {
    const week = offered({ maxBookingsPerWeek: 1 }, [booking('2026-03-04T15:00:00Z')]);
    // Mon 2 .. Sun 8 closed (Sunday 8 is also the DST change); Monday 9 open.
    expect(Object.keys(week)).toEqual(['2026-03-09']);
    // Sunday March 1, 21:00 in New York is already Monday 02:00 UTC: it belongs
    // to the week before, so this whole week stays open.
    const before = offered({ maxBookingsPerWeek: 1 }, [booking('2026-03-02T02:00:00Z')]);
    expect(Object.keys(before)).toHaveLength(8);
  });

  it('minutes per week leave room for exactly what still fits', () => {
    expect(offered({ maxMinutesPerWeek: 90 }, [booking('2026-03-02T15:00:00Z', 60)])['2026-03-08']).toBe(6);
    const full = [booking('2026-03-02T15:00:00Z', 60), booking('2026-03-03T15:00:00Z', 30)];
    expect(Object.keys(offered({ maxMinutesPerWeek: 90 }, full))).toEqual(['2026-03-09']);
  });

  it('counts a booking on its day in the zone across a DST change that skips midnight', () => {
    // Santiago: Saturday Sept 5 ends at 24:00 (-04) and Sunday starts at 01:00 (-03) = 04:00Z.
    const span = { tz: 'America/Santiago', from: '2026-09-05T04:00:00Z', to: '2026-09-07T03:00:00Z' };
    const lateSaturday = offered({ maxBookingsPerDay: 1 }, [booking('2026-09-06T03:30:00Z')], span);
    expect(lateSaturday).toEqual({ '2026-09-06': 6 });
    const firstSundayMinute = offered({ maxBookingsPerDay: 1 }, [booking('2026-09-06T04:00:00Z')], span);
    expect(firstSundayMinute).toEqual({ '2026-09-05': 6 });
  });

  it('on a seated event a time already booked takes a seat, not another booking', () => {
    const r = offered({ maxBookingsPerDay: 1 }, [booking('2026-03-04T15:00:00Z')], { seated: true });
    expect(r['2026-03-04']).toBe(1);
  });

  it('computeSlotsDetailed lists the times a limit closed, never a busy one', () => {
    const r = computeSlotsDetailed({
      fromUtc: new Date('2026-03-04T05:00:00Z'),
      toUtc: new Date('2026-03-06T05:00:00Z'),
      timeZone: NY,
      availability: [everyDay],
      durationMin: 30,
      busy: [booking('2026-03-04T14:00:00Z')],
      now: new Date('2026-02-01T00:00:00Z'),
      bookingLimits: { limits: { maxBookingsPerDay: 1 }, booked: [booking('2026-03-04T15:00:00Z')] },
    });
    expect(perDay(r.slots, NY)).toEqual({ '2026-03-05': 6 });
    // Six times on Wednesday, less the busy 09:00.
    expect(r.full.map((d) => d.toISOString())).toEqual(
      ['14:30', '15:00', '15:30', '16:00', '16:30'].map((t) => `2026-03-04T${t}:00.000Z`),
    );
  });

  it('names the period a time breaks, read in the input zone when it has one (a team event reads its own)', () => {
    const wed = [booking('2026-03-04T15:00:00Z')];
    expect(bookingLimitBreach({ limits: { maxBookingsPerDay: 2, maxBookingsPerWeek: 1 }, booked: wed }, NY, Date.parse('2026-03-05T15:00:00Z'), 30)).toBe('week');
    expect(bookingLimitBreach({ limits: { maxBookingsPerDay: 1 }, booked: wed }, NY, Date.parse('2026-03-04T16:00:00Z'), 30)).toBe('day');
    expect(bookingLimitBreach({ limits: { maxBookingsPerDay: 1 }, booked: wed }, NY, Date.parse('2026-03-05T16:00:00Z'), 30)).toBeNull();
    // Wednesday 23:30 in New York is already Thursday in UTC.
    const late = { limits: { maxBookingsPerDay: 1 }, booked: [booking('2026-03-05T04:30:00Z')] };
    expect(bookingLimitBreach(late, NY, Date.parse('2026-03-04T15:00:00Z'), 30)).toBe('day');
    expect(bookingLimitBreach({ ...late, timeZone: 'UTC' }, NY, Date.parse('2026-03-04T15:00:00Z'), 30)).toBeNull();
  });
});
