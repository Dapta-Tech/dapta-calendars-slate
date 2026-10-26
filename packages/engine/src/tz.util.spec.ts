import { localDateParts, tzOffsetMs, zonedWallClockToUtc } from './tz.util';

describe('tz.util', () => {
  describe('zonedWallClockToUtc', () => {
    it('projects a no-DST zone (America/Bogota, UTC-5) correctly', () => {
      const utc = zonedWallClockToUtc(
        { year: 2026, month: 7, day: 6, hour: 9, minute: 0 },
        'America/Bogota',
      );
      expect(utc.toISOString()).toBe('2026-07-06T14:00:00.000Z');
    });

    it('uses EST (UTC-5) BEFORE the US spring-forward boundary', () => {
      // 2026-03-07 09:00 America/New_York is still EST → 14:00 UTC.
      const utc = zonedWallClockToUtc(
        { year: 2026, month: 3, day: 7, hour: 9, minute: 0 },
        'America/New_York',
      );
      expect(utc.toISOString()).toBe('2026-03-07T14:00:00.000Z');
    });

    it('uses EDT (UTC-4) AFTER the US spring-forward boundary', () => {
      // 2026-03-08 (DST starts 02:00) 09:00 America/New_York is EDT → 13:00 UTC.
      const utc = zonedWallClockToUtc(
        { year: 2026, month: 3, day: 8, hour: 9, minute: 0 },
        'America/New_York',
      );
      expect(utc.toISOString()).toBe('2026-03-08T13:00:00.000Z');
    });

    it('uses EDT before and EST after the US fall-back boundary', () => {
      expect(
        zonedWallClockToUtc(
          { year: 2026, month: 10, day: 31, hour: 9, minute: 0 },
          'America/New_York',
        ).toISOString(),
      ).toBe('2026-10-31T13:00:00.000Z'); // EDT (-4)
      expect(
        zonedWallClockToUtc(
          { year: 2026, month: 11, day: 1, hour: 9, minute: 0 },
          'America/New_York',
        ).toISOString(),
      ).toBe('2026-11-01T14:00:00.000Z'); // EST (-5)
    });
  });

  describe('zonedWallClockToUtc in DST gaps and overlaps', () => {
    const at = (zone: string, y: number, mo: number, d: number, h: number, mi: number) =>
      zonedWallClockToUtc({ year: y, month: mo, day: d, hour: h, minute: mi }, zone).toISOString();

    // A gap time never happens on the zone's clock; it resolves forward to the
    // transition, the first instant after the gap, never back to before it.
    describe('spring-forward gap: forward to the transition', () => {
      it('America/New_York, 2026-03-08 02:00 to 03:00 (EST to EDT at 07:00Z)', () => {
        expect(at('America/New_York', 2026, 3, 8, 2, 0)).toBe('2026-03-08T07:00:00.000Z'); // 03:00 EDT, not 01:00 EST
        expect(at('America/New_York', 2026, 3, 8, 2, 30)).toBe('2026-03-08T07:00:00.000Z');
        // Either side of the gap is an ordinary time.
        expect(at('America/New_York', 2026, 3, 8, 1, 59)).toBe('2026-03-08T06:59:00.000Z'); // EST
        expect(at('America/New_York', 2026, 3, 8, 3, 0)).toBe('2026-03-08T07:00:00.000Z'); // EDT
      });

      it('America/Santiago, 2026-09-06 00:00 to 01:00 (-04 to -03 at 04:00Z)', () => {
        // A Sunday that starts at midnight starts at 01:00, not at 23:00 on Saturday.
        expect(at('America/Santiago', 2026, 9, 6, 0, 0)).toBe('2026-09-06T04:00:00.000Z');
        expect(at('America/Santiago', 2026, 9, 6, 0, 30)).toBe('2026-09-06T04:00:00.000Z');
        expect(at('America/Santiago', 2026, 9, 6, 1, 0)).toBe('2026-09-06T04:00:00.000Z');
        expect(at('America/Santiago', 2026, 9, 5, 23, 59)).toBe('2026-09-06T03:59:00.000Z'); // -04
      });

      it('America/Asuncion, 2024-10-06 00:00 to 01:00, its last change before fixed -03', () => {
        expect(at('America/Asuncion', 2024, 10, 6, 0, 0)).toBe('2024-10-06T04:00:00.000Z');
        expect(at('America/Asuncion', 2024, 10, 6, 0, 45)).toBe('2024-10-06T04:00:00.000Z');
      });

      it('Europe/Berlin, east of UTC: 2026-03-29 02:00 to 03:00 (at 01:00Z)', () => {
        expect(at('Europe/Berlin', 2026, 3, 29, 2, 30)).toBe('2026-03-29T01:00:00.000Z'); // 03:00 CEST
        expect(at('Europe/Berlin', 2026, 3, 29, 1, 30)).toBe('2026-03-29T00:30:00.000Z'); // CET, before the gap
      });

      it('Australia/Lord_Howe, a half-hour change: 2026-10-04 02:00 to 02:30', () => {
        // +10:30 to +11 at 2026-10-03T15:30Z: the transition is found to the
        // minute, not rounded to an hour.
        expect(at('Australia/Lord_Howe', 2026, 10, 4, 2, 15)).toBe('2026-10-03T15:30:00.000Z');
      });
    });

    // An overlap time happens twice; it resolves to the first occurrence, on
    // the offset in force before the clocks went back.
    describe('fall-back overlap: the first occurrence', () => {
      it('America/New_York, 2026-11-01 01:00 to 02:00 happens twice', () => {
        expect(at('America/New_York', 2026, 11, 1, 1, 30)).toBe('2026-11-01T05:30:00.000Z'); // EDT, not 06:30Z EST
      });

      it('America/Santiago, 2026-04-04 23:00 to 24:00 happens twice', () => {
        expect(at('America/Santiago', 2026, 4, 4, 23, 30)).toBe('2026-04-05T02:30:00.000Z'); // -03, not 03:30Z
      });

      it('America/Asuncion, 2024-03-23 23:00 to 24:00 happens twice', () => {
        expect(at('America/Asuncion', 2024, 3, 23, 23, 30)).toBe('2024-03-24T02:30:00.000Z'); // -03
      });

      it('Europe/Berlin, east of UTC: 2026-10-25 02:00 to 03:00 happens twice', () => {
        expect(at('Europe/Berlin', 2026, 10, 25, 2, 30)).toBe('2026-10-25T00:30:00.000Z'); // CEST, not 01:30Z CET
      });
    });
  });

  describe('tzOffsetMs', () => {
    it('reports -5h in EST and -4h in EDT', () => {
      const H = 3_600_000;
      expect(tzOffsetMs(new Date('2026-01-15T12:00:00Z'), 'America/New_York')).toBe(-5 * H);
      expect(tzOffsetMs(new Date('2026-07-15T12:00:00Z'), 'America/New_York')).toBe(-4 * H);
    });
  });

  describe('localDateParts', () => {
    it('returns the civil date + weekday as seen in the zone', () => {
      // 2026-07-06T02:00Z is 2026-07-05 21:00 in Bogota (−5) → previous day.
      const p = localDateParts(new Date('2026-07-06T02:00:00Z'), 'America/Bogota');
      expect(p).toEqual({ year: 2026, month: 7, day: 5, weekday: 0 }); // Sunday
    });
  });
});
