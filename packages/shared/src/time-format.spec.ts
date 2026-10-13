import { describe, expect, it, vi } from 'vitest';
import {
  commonTimeZones,
  detectTimeZone,
  formatDayKeyLong,
  formatSlotDateTime,
  formatSlotTime,
  isValidTimeZone,
  zoneOffsetLabel,
  zoneOffsetMinutes,
  zonedDayKey,
} from './time';

/**
 * The times a visitor reads: a slot's clock time, the full date line of the
 * details step, the day a cell names, a zone's offset. The instants are fixed
 * and straddle the 2026 daylight-saving changes, so each line is checked on
 * both sides of a clock change.
 */
const BEFORE_US_DST_END = '2026-10-30T14:00:00.000Z'; // 10:00 New York, EDT
const AFTER_US_DST_END = '2026-11-02T15:00:00.000Z'; // 10:00 New York, EST

describe('formatSlotTime', () => {
  it('names the same wall-clock time either side of a clock change', () => {
    expect(formatSlotTime(BEFORE_US_DST_END, 'America/New_York')).toBe('10:00 AM');
    expect(formatSlotTime(AFTER_US_DST_END, 'America/New_York')).toBe('10:00 AM');
  });

  it('24h is the 00-23 clock: midnight is 00:00, never 24:00', () => {
    expect(formatSlotTime('2026-10-14T04:00:00.000Z', 'America/New_York', 'en-US', false)).toBe('00:00');
    expect(formatSlotTime('2026-10-14T04:00:00.000Z', 'America/New_York', 'es', false)).toBe('0:00');
  });

  it('12h on request, even in a 24h locale', () => {
    expect(formatSlotTime(BEFORE_US_DST_END, 'America/Bogota', 'es', true)).toMatch(/^9:00\s?a\.?\s?m\.?$/i);
  });

  it('a zone with a half-hour offset', () => {
    expect(formatSlotTime('2026-10-14T04:00:00.000Z', 'Asia/Kolkata', 'en-US', false)).toBe('09:30');
  });
});

describe('formatSlotDateTime', () => {
  it('says the weekday, the date, the time and the zone', () => {
    const line = formatSlotDateTime(BEFORE_US_DST_END, 'America/New_York');
    expect(line).toContain('Friday');
    expect(line).toContain('October 30, 2026');
    expect(line).toContain('10:00');
    expect(line).toMatch(/EDT/);
    expect(formatSlotDateTime(AFTER_US_DST_END, 'America/New_York')).toMatch(/EST/);
  });

  it('in Spanish', () => {
    const line = formatSlotDateTime(BEFORE_US_DST_END, 'America/Bogota', 'es', false);
    expect(line).toContain('viernes');
    expect(line).toContain('octubre');
    expect(line).toContain(' 9:00');
  });
});

describe('the day a time falls on', () => {
  it('is the day in the reader zone, not in UTC', () => {
    // 03:00 UTC on the 14th is still the 13th in New York and already the 14th in Tokyo.
    expect(zonedDayKey('2026-10-14T03:00:00.000Z', 'America/New_York')).toBe('2026-10-13');
    expect(zonedDayKey('2026-10-14T03:00:00.000Z', 'Asia/Tokyo')).toBe('2026-10-14');
  });

  it('a cell names its whole date, in the reader language', () => {
    expect(formatDayKeyLong('2026-10-14')).toBe('Wednesday, October 14');
    expect(formatDayKeyLong('2026-10-14', 'es')).toBe('miércoles, 14 de octubre');
  });
});

describe('offsets', () => {
  it('follows the clock change', () => {
    expect(zoneOffsetMinutes(new Date(BEFORE_US_DST_END), 'America/New_York')).toBe(-240);
    expect(zoneOffsetMinutes(new Date(AFTER_US_DST_END), 'America/New_York')).toBe(-300);
    expect(zoneOffsetMinutes(new Date(BEFORE_US_DST_END), 'Asia/Kolkata')).toBe(330);
    expect(zoneOffsetLabel('America/New_York', new Date(BEFORE_US_DST_END))).toBe('GMT-4');
    expect(zoneOffsetLabel('America/New_York', new Date(AFTER_US_DST_END))).toBe('GMT-5');
  });

  it('an unknown zone labels as nothing rather than throwing', () => {
    expect(zoneOffsetLabel('Not/AZone')).toBe('');
  });
});

describe('the zone list and the detected zone', () => {
  it('always includes the zone asked for, once', () => {
    const zones = commonTimeZones('America/Bogota');
    expect(zones.filter((z) => z === 'America/Bogota')).toHaveLength(1);
    expect(commonTimeZones('Etc/GMT+3')[0]).toBe('Etc/GMT+3');
  });

  it('falls back to a curated list where the runtime cannot enumerate zones', () => {
    const intl = Intl as unknown as { supportedValuesOf?: unknown };
    const original = intl.supportedValuesOf;
    intl.supportedValuesOf = undefined;
    try {
      const zones = commonTimeZones('America/Bogota');
      expect(zones.length).toBeGreaterThan(10);
      expect(zones).toContain('America/Bogota');
    } finally {
      intl.supportedValuesOf = original;
    }
  });

  it('detects the runtime zone, and says UTC when it cannot', () => {
    // Whatever the runtime is set to (CI runners are often plain UTC), a real zone.
    expect(isValidTimeZone(detectTimeZone())).toBe(true);
    const spy = vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(() => {
      throw new Error('no Intl');
    });
    try {
      expect(detectTimeZone()).toBe('UTC');
    } finally {
      spy.mockRestore();
    }
  });
});
