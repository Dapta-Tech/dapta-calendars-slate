import { describe, expect, it } from 'vitest';
import { bookingWindowEnd, computeSlots, type AvailabilityRule } from './slots';
import { localDateParts } from './tz.util';

const everyDay = (start: string, end: string): AvailabilityRule => ({
  days: [0, 1, 2, 3, 4, 5, 6],
  startTime: start,
  endTime: end,
  date: null,
});

/** The civil date of an instant in `tz`, as "YYYY-MM-DD". */
function dayIn(instant: Date, tz: string): string {
  const p = localDateParts(instant, tz);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** The days, in `tz`, that a list of slots falls on, once each. */
const days = (slots: Date[], tz: string) => [...new Set(slots.map((d) => dayIn(d, tz)))];

describe('bookingWindowEnd: the first instant past "up to N calendar days ahead"', () => {
  it('is no window at all for null or absent', () => {
    expect(bookingWindowEnd(new Date('2026-07-06T14:00:00Z'), 'America/New_York', null)).toBeNull();
    expect(bookingWindowEnd(new Date('2026-07-06T14:00:00Z'), 'America/New_York', undefined)).toBeNull();
  });

  it('counts today as day 0: 14 days on Monday the 6th ends as Monday the 20th ends, whatever the hour', () => {
    const tz = 'America/New_York';
    // 10:00 EDT and 23:59 EDT on Monday July 6: the same window.
    for (const now of ['2026-07-06T14:00:00Z', '2026-07-07T03:59:00Z']) {
      expect(bookingWindowEnd(new Date(now), tz, 14)!.toISOString()).toBe('2026-07-21T04:00:00.000Z');
    }
    expect(bookingWindowEnd(new Date('2026-07-06T14:00:00Z'), tz, 1)!.toISOString()).toBe('2026-07-08T04:00:00.000Z');
  });

  it('reads today in the schedule zone, not in UTC', () => {
    // 02:00Z on July 7 is still July 6 in New York and already July 7 in Tokyo.
    const now = new Date('2026-07-07T02:00:00Z');
    expect(dayIn(new Date(bookingWindowEnd(now, 'America/New_York', 1)!.getTime() - 1), 'America/New_York')).toBe('2026-07-07');
    expect(dayIn(new Date(bookingWindowEnd(now, 'Asia/Tokyo', 1)!.getTime() - 1), 'Asia/Tokyo')).toBe('2026-07-08');
    expect(dayIn(new Date(bookingWindowEnd(now, 'UTC', 1)!.getTime() - 1), 'UTC')).toBe('2026-07-08');
  });

  it('rolls over months and years', () => {
    expect(bookingWindowEnd(new Date('2026-12-30T15:00:00Z'), 'UTC', 3)!.toISOString()).toBe('2027-01-03T00:00:00.000Z');
    expect(bookingWindowEnd(new Date('2028-02-27T15:00:00Z'), 'UTC', 2)!.toISOString()).toBe('2028-03-01T00:00:00.000Z');
  });

  it('keeps the window in calendar days across DST changes (New York, both directions)', () => {
    const tz = 'America/New_York';
    // Spring forward Sunday March 8 2026: March 7 starts at 05:00Z (EST), March 9 at 04:00Z (EDT).
    expect(bookingWindowEnd(new Date('2026-03-06T17:00:00Z'), tz, 0)!.toISOString()).toBe('2026-03-07T05:00:00.000Z');
    expect(bookingWindowEnd(new Date('2026-03-06T17:00:00Z'), tz, 2)!.toISOString()).toBe('2026-03-09T04:00:00.000Z');
    // Fall back Sunday November 1 2026: November 2 starts at 05:00Z (EST).
    expect(bookingWindowEnd(new Date('2026-10-31T16:00:00Z'), tz, 1)!.toISOString()).toBe('2026-11-02T05:00:00.000Z');
  });

  it('starts a day whose midnight DST skips at the transition, so none of that day is lost or added', () => {
    // Santiago skips from Saturday September 5 2026, 24:00 (-04) to Sunday 01:00 (-03):
    // Sunday starts at 04:00Z, and the instant before it is still Saturday.
    expect(bookingWindowEnd(new Date('2026-09-04T15:00:00Z'), 'America/Santiago', 1)!.toISOString()).toBe(
      '2026-09-06T04:00:00.000Z',
    );
    // Zones whose clocks jump at midnight on some days of the year.
    for (const tz of ['America/Santiago', 'America/Havana', 'America/Asuncion', 'Asia/Beirut']) {
      for (let month = 0; month < 12; month++) {
        for (const dayOfMonth of [1, 8, 15, 22]) {
          const now = new Date(Date.UTC(2026, month, dayOfMonth, 15));
          for (const n of [0, 1, 6, 30]) {
            const end = bookingWindowEnd(now, tz, n)!;
            const today = localDateParts(now, tz);
            const last = new Date(Date.UTC(today.year, today.month - 1, today.day + n));
            const lastKey = last.toISOString().slice(0, 10);
            // The instant just before the end is still on day N; the end is on day N + 1.
            expect(dayIn(new Date(end.getTime() - 1), tz), `${tz} ${now.toISOString()} n=${n}`).toBe(lastKey);
            expect(dayIn(end, tz), `${tz} ${now.toISOString()} n=${n}`).not.toBe(lastKey);
          }
        }
      }
    }
  });

  it('never throws on a value past the API bounds written straight into the column', () => {
    const now = new Date('2026-07-06T14:00:00Z');
    for (const wild of [1e9, Number.POSITIVE_INFINITY, -5, 2.7]) {
      expect(() => bookingWindowEnd(now, 'UTC', wild)).not.toThrow();
      expect(Number.isNaN(bookingWindowEnd(now, 'UTC', wild)!.getTime()), String(wild)).toBe(false);
    }
    expect(bookingWindowEnd(now, 'UTC', -5)!.toISOString()).toBe('2026-07-07T00:00:00.000Z');
    expect(bookingWindowEnd(now, 'UTC', 2.7)!.toISOString()).toBe('2026-07-09T00:00:00.000Z');
    expect(bookingWindowEnd(now, 'UTC', Number.NaN)).toBeNull();
    expect(() =>
      computeSlots({
        timeZone: 'UTC',
        availability: [everyDay('09:00', '10:00')],
        durationMin: 60,
        busy: [],
        now,
        fromUtc: now,
        toUtc: new Date('2026-07-20T00:00:00Z'),
        bookingWindowDays: 1e9,
      }),
    ).not.toThrow();
  });

  it('handles the zones furthest from UTC', () => {
    for (const tz of ['Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Australia/Lord_Howe', 'Asia/Kathmandu']) {
      const now = new Date('2026-04-05T12:00:00Z');
      const end = bookingWindowEnd(now, tz, 3)!;
      const today = localDateParts(now, tz);
      const last = new Date(Date.UTC(today.year, today.month - 1, today.day + 3)).toISOString().slice(0, 10);
      expect(dayIn(new Date(end.getTime() - 1), tz), tz).toBe(last);
      expect(dayIn(end, tz), tz).not.toBe(last);
    }
  });
});

describe('computeSlots with a booking window', () => {
  const tz = 'America/New_York';
  const base = {
    timeZone: tz,
    availability: [everyDay('09:00', '10:00')],
    durationMin: 60,
    busy: [],
    // Monday July 6 2026, 08:00 EDT.
    now: new Date('2026-07-06T12:00:00Z'),
    fromUtc: new Date('2026-07-06T00:00:00Z'),
    toUtc: new Date('2026-07-20T00:00:00Z'),
  };

  it('offers no slot past the window, and changes nothing without one', () => {
    expect(days(computeSlots(base), tz)).toHaveLength(14);
    expect(days(computeSlots({ ...base, bookingWindowDays: null }), tz)).toHaveLength(14);
    expect(days(computeSlots({ ...base, bookingWindowDays: 2 }), tz)).toEqual(['2026-07-06', '2026-07-07', '2026-07-08']);
  });

  it('keeps the last day whole: a slot late on day N is in, the first one of day N + 1 is out', () => {
    const late = { ...base, availability: [everyDay('22:30', '23:30'), everyDay('00:00', '01:00')] };
    const slots = computeSlots({ ...late, bookingWindowDays: 1 }).map((d) => d.toISOString());
    // July 7 22:30 EDT = July 8 02:30Z is in; July 8 00:00 EDT = 04:00Z is out.
    expect(slots).toContain('2026-07-08T02:30:00.000Z');
    expect(slots).not.toContain('2026-07-08T04:00:00.000Z');
  });

  it('applies with the minimum notice and the search window, the tightest edge winning', () => {
    // Notice pushes today out; the window still ends after July 7.
    const noticed = computeSlots({ ...base, minimumBookingNoticeMin: 24 * 60, bookingWindowDays: 1 });
    expect(days(noticed, tz)).toEqual(['2026-07-07']);
    // A search that ends before the window is not stretched by it.
    const short = computeSlots({ ...base, toUtc: new Date('2026-07-07T00:00:00Z'), bookingWindowDays: 30 });
    expect(days(short, tz)).toEqual(['2026-07-06']);
    // A search that starts past the window finds nothing.
    expect(computeSlots({ ...base, fromUtc: new Date('2026-07-10T00:00:00Z'), bookingWindowDays: 2 })).toEqual([]);
  });

  it('counts the days in the schedule zone, not the invitee\'s', () => {
    // 23:00 EDT on July 6 is already July 7 in UTC; New York's July 6 is today.
    const now = new Date('2026-07-07T03:00:00Z');
    const slots = computeSlots({ ...base, now, fromUtc: now, bookingWindowDays: 1 });
    expect(days(slots, tz)).toEqual(['2026-07-07']);
  });

  it('is DST-safe at the edge: a window ending the day after spring forward keeps that day\'s 09:00', () => {
    const spring = {
      ...base,
      now: new Date('2026-03-06T17:00:00Z'),
      fromUtc: new Date('2026-03-06T17:00:00Z'),
      toUtc: new Date('2026-03-20T00:00:00Z'),
    };
    const slots = computeSlots({ ...spring, bookingWindowDays: 2 }).map((d) => d.toISOString());
    // March 7 09:00 EST = 14:00Z and March 8 09:00 EDT = 13:00Z are in; March 9 is out.
    expect(slots).toEqual(['2026-03-07T14:00:00.000Z', '2026-03-08T13:00:00.000Z']);
  });
});
