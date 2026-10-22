import {
  AvailabilityRule,
  computeSlots,
  Interval,
  mergeIntervals,
  unionInstants,
  intersectInstants,
} from './slots';

const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const iso = (slots: Date[]) => slots.map(d => d.toISOString());

/** A recurring block on every weekday. */
function recurring(startTime: string, endTime: string): AvailabilityRule {
  return { days: ALL_DAYS, startTime, endTime, date: null };
}

describe('computeSlots', () => {
  const NOW_EARLY = new Date('2026-01-01T00:00:00Z'); // far before any test window

  describe('basic generation (America/Bogota, no DST)', () => {
    const base = {
      timeZone: 'America/Bogota',
      availability: [recurring('09:00', '11:00')],
      durationMin: 30,
      slotIntervalMin: 30,
      busy: [] as Interval[],
      now: NOW_EARLY,
      // Local Jul 6 00:00 → 05:00Z; one full local day.
      fromUtc: new Date('2026-07-06T05:00:00Z'),
      toUtc: new Date('2026-07-07T05:00:00Z'),
    };

    it('generates evenly-stepped slots inside the block', () => {
      expect(iso(computeSlots(base))).toEqual([
        '2026-07-06T14:00:00.000Z', // 09:00 local
        '2026-07-06T14:30:00.000Z',
        '2026-07-06T15:00:00.000Z',
        '2026-07-06T15:30:00.000Z', // 10:30–11:00 local, last that fits
      ]);
    });

    it('subtracts an overlapping busy interval (adjacent slots survive)', () => {
      const busy = [
        { start: new Date('2026-07-06T14:30:00Z'), end: new Date('2026-07-06T15:00:00Z') },
      ];
      expect(iso(computeSlots({ ...base, busy }))).toEqual([
        '2026-07-06T14:00:00.000Z',
        '2026-07-06T15:00:00.000Z',
        '2026-07-06T15:30:00.000Z',
      ]);
    });

    it('treats existing bookings and reservations identically (same busy union)', () => {
      // One "accepted booking" + one "active reservation", merged as busy.
      const busy = [
        { start: new Date('2026-07-06T14:00:00Z'), end: new Date('2026-07-06T14:30:00Z') }, // booking
        { start: new Date('2026-07-06T15:00:00Z'), end: new Date('2026-07-06T15:30:00Z') }, // reservation
      ];
      expect(iso(computeSlots({ ...base, busy }))).toEqual([
        '2026-07-06T14:30:00.000Z',
        '2026-07-06T15:30:00.000Z',
      ]);
    });

    it('applies before/after buffers around the candidate', () => {
      const busy = [
        { start: new Date('2026-07-06T14:30:00Z'), end: new Date('2026-07-06T15:00:00Z') },
      ];
      // 15-min buffers knock out both neighbours of the busy block; only the
      // 15:30 slot sits clear of the buffered busy window.
      expect(iso(computeSlots({ ...base, busy, beforeBufferMin: 15, afterBufferMin: 15 }))).toEqual(
        ['2026-07-06T15:30:00.000Z'],
      );
    });

    it('excludes slots before now + minimumBookingNotice', () => {
      const now = new Date('2026-07-06T14:10:00Z');
      expect(iso(computeSlots({ ...base, now, minimumBookingNoticeMin: 60 }))).toEqual([
        '2026-07-06T15:30:00.000Z', // earliest = 15:10Z → only 15:30 qualifies
      ]);
    });
  });

  describe('DST correctness (America/New_York)', () => {
    it('spring-forward: the same 09:00 block yields −4h on the post-DST day', () => {
      const slots = iso(
        computeSlots({
          timeZone: 'America/New_York',
          availability: [recurring('09:00', '10:00')],
          durationMin: 60,
          busy: [],
          now: NOW_EARLY,
          fromUtc: new Date('2026-03-07T00:00:00Z'),
          toUtc: new Date('2026-03-09T00:00:00Z'),
        }),
      );
      // Mar 7 is EST (09:00→14:00Z); Mar 8 (DST on) is EDT (09:00→13:00Z).
      expect(slots).toEqual(['2026-03-07T14:00:00.000Z', '2026-03-08T13:00:00.000Z']);
    });

    it('fall-back: the same 09:00 block yields −5h on the post-DST day', () => {
      const slots = iso(
        computeSlots({
          timeZone: 'America/New_York',
          availability: [recurring('09:00', '10:00')],
          durationMin: 60,
          busy: [],
          now: NOW_EARLY,
          fromUtc: new Date('2026-10-31T00:00:00Z'),
          toUtc: new Date('2026-11-02T00:00:00Z'),
        }),
      );
      // Oct 31 EDT (09:00→13:00Z); Nov 1 (DST off) EST (09:00→14:00Z).
      expect(slots).toEqual(['2026-10-31T13:00:00.000Z', '2026-11-01T14:00:00.000Z']);
    });
  });

  describe('DST gaps and overlaps inside a block', () => {
    /** A recurring block on one weekday only. */
    const on = (day: number, startTime: string, endTime: string): AvailabilityRule => ({
      days: [day],
      startTime,
      endTime,
      date: null,
    });

    /**
     * What `isSlotBookable` asks before a booking or a reschedule is written:
     * the same rules over the meeting's own window must offer that start.
     */
    const bookable = (input: Parameters<typeof computeSlots>[0], startMs: number): boolean =>
      computeSlots({
        ...input,
        fromUtc: new Date(startMs),
        toUtc: new Date(startMs + input.durationMin * 60_000),
      }).some(d => d.getTime() === startMs);

    it.each([
      [60, ['2026-09-06T04:00:00.000Z', '2026-09-06T05:00:00.000Z']], // 01:00, 02:00 -03
      [30, ['2026-09-06T04:00:00.000Z', '2026-09-06T04:30:00.000Z', '2026-09-06T05:00:00.000Z', '2026-09-06T05:30:00.000Z']],
    ])('America/Santiago: Sunday hours from 00:00 start at 01:00 when the clocks skip midnight (%i min)', (durationMin, expected) => {
      // 2026-09-06: 00:00 -04 jumps to 01:00 -03 (04:00Z). The old projection
      // started the block at Saturday 23:00 -04 (03:00Z); with 30 minutes it
      // offered 03:00Z, which the booking check, reading Saturday only, refused.
      const input = {
        timeZone: 'America/Santiago',
        availability: [on(0, '00:00', '03:00')],
        durationMin,
        busy: [] as Interval[],
        now: NOW_EARLY,
        fromUtc: new Date('2026-09-05T00:00:00Z'),
        toUtc: new Date('2026-09-08T00:00:00Z'),
      };
      const slots = computeSlots(input);
      expect(iso(slots)).toEqual(expected);
      for (const d of slots) expect(bookable(input, d.getTime())).toBe(true);
      expect(bookable(input, Date.parse('2026-09-06T03:00:00Z'))).toBe(false); // Saturday 23:00 -04
    });

    it('America/Santiago: Saturday hours to 24:00 keep their last hour when midnight is skipped', () => {
      // The block ends at the transition (04:00Z), so 23:00 -04 (03:00Z) is offered.
      const input = {
        timeZone: 'America/Santiago',
        availability: [on(6, '20:00', '24:00')],
        durationMin: 60,
        busy: [] as Interval[],
        now: NOW_EARLY,
        fromUtc: new Date('2026-09-05T12:00:00Z'),
        toUtc: new Date('2026-09-07T00:00:00Z'),
      };
      const slots = computeSlots(input);
      expect(iso(slots)).toEqual([
        '2026-09-06T00:00:00.000Z', // 20:00 -04
        '2026-09-06T01:00:00.000Z',
        '2026-09-06T02:00:00.000Z',
        '2026-09-06T03:00:00.000Z', // 23:00 -04
      ]);
      for (const d of slots) expect(bookable(input, d.getTime())).toBe(true);
    });

    it('America/New_York: a block ending in the gap ends at the transition', () => {
      // 00:00 to 02:30 on 2026-03-08 covers 00:00 to 02:00 EST, every time before 02:30.
      const input = {
        timeZone: 'America/New_York',
        availability: [on(0, '00:00', '02:30')],
        durationMin: 30,
        busy: [] as Interval[],
        now: NOW_EARLY,
        fromUtc: new Date('2026-03-07T12:00:00Z'),
        toUtc: new Date('2026-03-09T12:00:00Z'),
      };
      const slots = computeSlots(input);
      expect(iso(slots)).toEqual([
        '2026-03-08T05:00:00.000Z', // 00:00 EST
        '2026-03-08T05:30:00.000Z',
        '2026-03-08T06:00:00.000Z',
        '2026-03-08T06:30:00.000Z', // 01:30 EST, ends at the transition
      ]);
      for (const d of slots) expect(bookable(input, d.getTime())).toBe(true);
    });

    it('Europe/Berlin: a block ending in the gap ends at the transition, east of UTC too', () => {
      // 00:00 to 02:30 on 2026-03-29 covers 00:00 to 02:00 CET; the old
      // projection ran it to 03:30 CEST.
      const input = {
        timeZone: 'Europe/Berlin',
        availability: [on(0, '00:00', '02:30')],
        durationMin: 30,
        busy: [] as Interval[],
        now: NOW_EARLY,
        fromUtc: new Date('2026-03-28T12:00:00Z'),
        toUtc: new Date('2026-03-30T12:00:00Z'),
      };
      const slots = computeSlots(input);
      expect(iso(slots)).toEqual([
        '2026-03-28T23:00:00.000Z', // 00:00 CET
        '2026-03-28T23:30:00.000Z',
        '2026-03-29T00:00:00.000Z',
        '2026-03-29T00:30:00.000Z', // 01:30 CET, ends at the transition
      ]);
      for (const d of slots) expect(bookable(input, d.getTime())).toBe(true);
      expect(bookable(input, Date.parse('2026-03-29T01:00:00Z'))).toBe(false); // 03:00 CEST
    });

    it('America/New_York: hours wholly inside the gap offer nothing that day', () => {
      // 02:00 to 02:45 never happens on 2026-03-08; both ends land on the transition.
      const input = {
        timeZone: 'America/New_York',
        availability: [{ days: null, startTime: '02:00', endTime: '02:45', date: '2026-03-08' }],
        durationMin: 30,
        busy: [] as Interval[],
        now: NOW_EARLY,
        fromUtc: new Date('2026-03-07T12:00:00Z'),
        toUtc: new Date('2026-03-09T12:00:00Z'),
      };
      expect(computeSlots(input)).toEqual([]);
      expect(bookable(input, Date.parse('2026-03-08T06:00:00Z'))).toBe(false); // 01:00 EST
    });

    it('America/New_York: a block starting in the gap starts at 03:00 EDT, not 01:00 EST', () => {
      // 2026-03-08 02:00 EST jumps to 03:00 EDT (07:00Z).
      const input = {
        timeZone: 'America/New_York',
        availability: [on(0, '02:00', '05:00')],
        durationMin: 60,
        busy: [] as Interval[],
        now: NOW_EARLY,
        fromUtc: new Date('2026-03-07T12:00:00Z'),
        toUtc: new Date('2026-03-09T12:00:00Z'),
      };
      const slots = computeSlots(input);
      expect(iso(slots)).toEqual(['2026-03-08T07:00:00.000Z', '2026-03-08T08:00:00.000Z']); // 03:00, 04:00 EDT
      for (const d of slots) expect(bookable(input, d.getTime())).toBe(true);
      expect(bookable(input, Date.parse('2026-03-08T06:00:00Z'))).toBe(false); // 01:00 EST
    });

    it('America/Asuncion: a block ending in the overlap ends at its first occurrence', () => {
      // 2024-03-24 00:00 -03 went back to 23:00 -04 on the 23rd (03:00Z), so
      // Saturday 23:00 to 24:00 happened twice; the block ends at the first 23:30.
      const input = {
        timeZone: 'America/Asuncion',
        availability: [on(6, '22:00', '23:30')],
        durationMin: 30,
        busy: [] as Interval[],
        now: new Date('2024-01-01T00:00:00Z'),
        fromUtc: new Date('2024-03-23T12:00:00Z'),
        toUtc: new Date('2024-03-25T00:00:00Z'),
      };
      const slots = computeSlots(input);
      // 22:00 -03 (01:00Z) up to 23:30 -03, the first 23:30 (02:30Z).
      expect(iso(slots)).toEqual([
        '2024-03-24T01:00:00.000Z',
        '2024-03-24T01:30:00.000Z',
        '2024-03-24T02:00:00.000Z',
      ]);
      for (const d of slots) expect(bookable(input, d.getTime())).toBe(true);
    });

    it('Europe/Berlin: a block starting in the overlap starts at its first occurrence', () => {
      // 2026-10-25 03:00 CEST went back to 02:00 CET (01:00Z): 02:00 to 04:00
      // local is three real hours, from 02:00 CEST (00:00Z).
      const input = {
        timeZone: 'Europe/Berlin',
        availability: [on(0, '02:00', '04:00')],
        durationMin: 60,
        busy: [] as Interval[],
        now: NOW_EARLY,
        fromUtc: new Date('2026-10-24T12:00:00Z'),
        toUtc: new Date('2026-10-26T12:00:00Z'),
      };
      const slots = computeSlots(input);
      expect(iso(slots)).toEqual([
        '2026-10-25T00:00:00.000Z', // 02:00 CEST
        '2026-10-25T01:00:00.000Z', // 02:00 CET
        '2026-10-25T02:00:00.000Z', // 03:00 CET
      ]);
      for (const d of slots) expect(bookable(input, d.getTime())).toBe(true);
    });

    it('Europe/Berlin: a block ending in the overlap ends at its first occurrence', () => {
      // 00:00 to 02:30 on 2026-10-25 ends at 02:30 CEST (00:30Z), not 02:30 CET.
      const input = {
        timeZone: 'Europe/Berlin',
        availability: [on(0, '00:00', '02:30')],
        durationMin: 30,
        busy: [] as Interval[],
        now: NOW_EARLY,
        fromUtc: new Date('2026-10-24T12:00:00Z'),
        toUtc: new Date('2026-10-26T12:00:00Z'),
      };
      const slots = computeSlots(input);
      expect(iso(slots)).toEqual([
        '2026-10-24T22:00:00.000Z', // 00:00 CEST
        '2026-10-24T22:30:00.000Z',
        '2026-10-24T23:00:00.000Z',
        '2026-10-24T23:30:00.000Z',
        '2026-10-25T00:00:00.000Z', // 02:00 CEST, the last that ends by the first 02:30
      ]);
      for (const d of slots) expect(bookable(input, d.getTime())).toBe(true);
    });
  });

  describe('date overrides', () => {
    it('a date override replaces recurring rules for that calendar date', () => {
      const slots = iso(
        computeSlots({
          timeZone: 'America/Bogota',
          availability: [
            recurring('09:00', '10:00'),
            { days: null, startTime: '13:00', endTime: '14:00', date: '2026-07-06' },
          ],
          durationMin: 60,
          busy: [],
          now: NOW_EARLY,
          fromUtc: new Date('2026-07-06T05:00:00Z'),
          toUtc: new Date('2026-07-07T05:00:00Z'),
        }),
      );
      // On 2026-07-06 the override wins: 13:00 local → 18:00Z; 09:00 suppressed.
      expect(slots).toEqual(['2026-07-06T18:00:00.000Z']);
    });
  });
});

describe('mergeIntervals', () => {
  it('merges overlapping and adjacent intervals', () => {
    const merged = mergeIntervals([
      { start: new Date('2026-07-06T10:00:00Z'), end: new Date('2026-07-06T11:00:00Z') },
      { start: new Date('2026-07-06T10:30:00Z'), end: new Date('2026-07-06T11:30:00Z') }, // overlaps
      { start: new Date('2026-07-06T11:30:00Z'), end: new Date('2026-07-06T12:00:00Z') }, // adjacent
      { start: new Date('2026-07-06T13:00:00Z'), end: new Date('2026-07-06T13:30:00Z') }, // separate
    ]);
    expect(iso(merged.map(m => m.start))).toEqual([
      '2026-07-06T10:00:00.000Z',
      '2026-07-06T13:00:00.000Z',
    ]);
    expect(iso(merged.map(m => m.end))).toEqual([
      '2026-07-06T12:00:00.000Z',
      '2026-07-06T13:30:00.000Z',
    ]);
  });
});

describe('unionInstants (round-robin team availability)', () => {
  it('offers a slot if any host is free, sorted and de-duplicated', () => {
    expect(unionInstants([new Set([30, 10]), new Set([10, 20])])).toEqual([10, 20, 30]);
  });

  it('returns empty for no hosts', () => {
    expect(unionInstants([])).toEqual([]);
  });
});

describe('intersectInstants (collective team availability)', () => {
  it('offers a slot only if every host is free', () => {
    expect(intersectInstants([new Set([10, 20, 30]), new Set([20, 30, 40]), new Set([30, 20])])).toEqual([20, 30]);
  });

  it('is empty when the hosts never overlap', () => {
    expect(intersectInstants([new Set([1, 2]), new Set([3, 4])])).toEqual([]);
  });

  it('is empty when any host has no free slots', () => {
    expect(intersectInstants([new Set([1, 2]), new Set()])).toEqual([]);
  });

  it('returns empty for no hosts', () => {
    expect(intersectInstants([])).toEqual([]);
  });

  it('with a single host equals that host free set (sorted)', () => {
    expect(intersectInstants([new Set([30, 10, 20])])).toEqual([10, 20, 30]);
  });
});

/**
 * Event lengths against gaps in the calendar.
 *
 * The host's day is rarely empty: it is meetings with holes between them, and
 * the holes are every size. These pin what a visitor is offered for each event
 * length against each kind of hole — the named cases first, then the same rule
 * checked exhaustively against an independent minute-by-minute oracle.
 */
describe('computeSlots — event lengths against gaps in the calendar', () => {
  const NOW_EARLY = new Date('2026-01-01T00:00:00Z');
  // One local day in America/Bogota (UTC−5, no DST): 09:00–18:00 local.
  const DAY_START = Date.parse('2026-07-06T05:00:00Z'); // 00:00 local
  const MIN = 60_000;
  /** "HH:mm" local → instant on the test day. */
  const local = (hhmm: string) => {
    const [h, m] = hhmm.split(':').map(Number) as [number, number];
    return new Date(DAY_START + (h * 60 + m) * MIN);
  };
  const busyAt = (...ranges: Array<[string, string]>): Interval[] =>
    ranges.map(([a, b]) => ({ start: local(a), end: local(b) }));
  /** Offered slot starts, as local "HH:mm". */
  const offered = (opts: {
    durationMin: number;
    slotIntervalMin?: number | null;
    busy?: Interval[];
    block?: [string, string];
  }) =>
    computeSlots({
      timeZone: 'America/Bogota',
      availability: [recurring(opts.block?.[0] ?? '09:00', opts.block?.[1] ?? '18:00')],
      durationMin: opts.durationMin,
      slotIntervalMin: opts.slotIntervalMin ?? null,
      busy: opts.busy ?? [],
      now: NOW_EARLY,
      fromUtc: new Date(DAY_START),
      toUtc: new Date(DAY_START + 24 * 60 * MIN),
    }).map((d) => {
      const mins = (d.getTime() - DAY_START) / MIN;
      return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
    });

  describe('a 30-minute event', () => {
    it('offers every half hour on an empty morning: 09:00, 09:30, 10:00 …', () => {
      expect(offered({ durationMin: 30, block: ['09:00', '11:00'] })).toEqual([
        '09:00',
        '09:30',
        '10:00',
        '10:30',
      ]);
    });

    it('a meeting at 13:15 takes 13:00 with it — the slot would run into the meeting', () => {
      // The reported case: nothing at 13:00, a meeting at 13:15. A 30-minute
      // slot at 13:00 ends at 13:30, inside the meeting, so it is not free.
      const slots = offered({ durationMin: 30, busy: busyAt(['13:15', '13:45']) });
      expect(slots).not.toContain('13:00');
      expect(slots).not.toContain('13:30');
      expect(slots).toContain('12:30'); // ends exactly as nothing starts: free
      expect(slots).toContain('14:00');
    });

    it('books back to back: a slot may end the minute a meeting starts, and start the minute one ends', () => {
      const slots = offered({ durationMin: 30, busy: busyAt(['10:00', '11:00']) });
      expect(slots).toContain('09:30'); // 09:30–10:00, touches the meeting's start
      expect(slots).toContain('11:00'); // starts as the meeting ends
      expect(slots).not.toContain('10:00');
      expect(slots).not.toContain('10:30');
    });

    it('fits a hole of exactly 30 minutes, and not one of 29', () => {
      expect(offered({ durationMin: 30, busy: busyAt(['09:00', '10:00'], ['10:30', '12:00']) })).toContain('10:00');
      expect(
        offered({ durationMin: 30, busy: busyAt(['09:00', '10:01'], ['10:30', '12:00']) }),
      ).not.toContain('10:00');
    });

    it('offers both halves of a one-hour hole', () => {
      const slots = offered({
        durationMin: 30,
        busy: busyAt(['09:00', '10:00'], ['11:00', '18:00']),
      });
      expect(slots).toEqual(['10:00', '10:30']);
    });
  });

  describe('a one-hour event', () => {
    it('offers every hour on an empty morning', () => {
      expect(offered({ durationMin: 60, block: ['09:00', '12:00'] })).toEqual(['09:00', '10:00', '11:00']);
    });

    it('does not fit a 30-minute hole', () => {
      const slots = offered({ durationMin: 60, busy: busyAt(['09:00', '10:00'], ['10:30', '12:00']) });
      expect(slots).not.toContain('10:00');
      expect(slots[0]).toBe('12:00');
    });

    it('fits a one-hour hole that sits on the hour', () => {
      expect(
        offered({ durationMin: 60, busy: busyAt(['09:00', '10:00'], ['11:00', '18:00']) }),
      ).toEqual(['10:00']);
    });

    it('one 30-minute meeting costs the whole hour it sits in, never more', () => {
      const slots = offered({ durationMin: 60, busy: busyAt(['10:30', '11:00']), block: ['09:00', '13:00'] });
      expect(slots).toEqual(['09:00', '11:00', '12:00']);
    });

    it('a one-hour hole off the hour (09:30–10:30) is offered only when starts are every 30 minutes', () => {
      const busy = busyAt(['09:00', '09:30'], ['10:30', '18:00']);
      // Starts follow the slot interval. Left at its default (the event's own
      // length) an hourly event starts on the hour, and this hole is missed.
      expect(offered({ durationMin: 60, busy })).toEqual([]);
      // With the interval at 30 the same hole is found.
      expect(offered({ durationMin: 60, slotIntervalMin: 30, busy })).toEqual(['09:30']);
    });
  });

  describe('other lengths', () => {
    it('15 minutes: four to the hour, and a 15-minute hole is enough', () => {
      expect(offered({ durationMin: 15, block: ['09:00', '10:00'] })).toEqual(['09:00', '09:15', '09:30', '09:45']);
      expect(
        offered({ durationMin: 15, busy: busyAt(['09:00', '09:45'], ['10:00', '18:00']) }),
      ).toEqual(['09:45']);
    });

    it('45 minutes on a 15-minute interval finds a 45-minute hole wherever it starts', () => {
      expect(
        offered({
          durationMin: 45,
          slotIntervalMin: 15,
          busy: busyAt(['09:00', '10:15'], ['11:00', '18:00']),
        }),
      ).toEqual(['10:15']);
    });

    it('90 minutes needs the full 90: an 89-minute hole offers nothing', () => {
      expect(
        offered({ durationMin: 90, slotIntervalMin: 30, busy: busyAt(['09:00', '10:00'], ['11:30', '18:00']) }),
      ).toEqual(['10:00']);
      expect(
        offered({ durationMin: 90, slotIntervalMin: 30, busy: busyAt(['09:00', '10:00'], ['11:29', '18:00']) }),
      ).toEqual([]);
    });

    it('the last slot of the day is the last one that ENDS inside the hours', () => {
      expect(offered({ durationMin: 60, block: ['09:00', '11:30'] })).toEqual(['09:00', '10:00']);
      expect(offered({ durationMin: 30, block: ['09:00', '10:15'] })).toEqual(['09:00', '09:30']);
    });
  });

  it('EXHAUSTIVE: for every length, interval and calendar, the offer is exactly the starts that fit', () => {
    // Deterministic generator: reproducible calendars, no flake.
    let seed = 20261005;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    const BLOCK_START = 9 * 60;
    const BLOCK_END = 18 * 60;
    let checked = 0;

    for (let round = 0; round < 60; round++) {
      // A day of meetings of every length at awkward offsets (:05, :15, :45 …).
      const meetings: Array<[number, number]> = [];
      const count = rand(9);
      for (let i = 0; i < count; i++) {
        const start = 8 * 60 + rand(11 * 12) * 5; // 08:00–19:00, on 5-minute marks
        const length = [10, 15, 25, 30, 45, 50, 60, 90, 120][rand(9)]!;
        meetings.push([start, start + length]);
      }
      const busy: Interval[] = meetings.map(([a, b]) => ({
        start: new Date(DAY_START + a * MIN),
        end: new Date(DAY_START + b * MIN),
      }));
      // The oracle: a minute is taken if any meeting covers it.
      const taken = new Array<boolean>(24 * 60).fill(false);
      for (const [a, b] of meetings) for (let m = a; m < b; m++) taken[m] = true;

      for (const durationMin of [15, 20, 30, 45, 60, 90, 120]) {
        for (const slotIntervalMin of [null, 5, 15, 30, 60]) {
          const step = slotIntervalMin ?? durationMin;
          const expected: string[] = [];
          for (let s = BLOCK_START; s + durationMin <= BLOCK_END; s += step) {
            let free = true;
            for (let m = s; m < s + durationMin; m++) if (taken[m]) free = false;
            if (free) {
              expected.push(`${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`);
            }
          }
          expect(
            offered({ durationMin, slotIntervalMin, busy }),
            `round ${round}, ${durationMin}min every ${step}min, meetings ${JSON.stringify(meetings)}`,
          ).toEqual(expected);
          checked++;
        }
      }
    }
    expect(checked).toBe(60 * 7 * 5);
  });
});
