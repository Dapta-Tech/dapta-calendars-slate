import { describe, expect, it } from 'vitest';
import { formatDayLong, formatTimeRange } from './time';

describe('formatDayLong', () => {
  it('says the day in the visitor zone, with the year', () => {
    expect(formatDayLong('2026-03-02T14:30:00.000Z', 'America/New_York', 'en')).toBe('Monday, March 2, 2026');
    expect(formatDayLong('2026-03-02T14:30:00.000Z', 'America/New_York', 'es')).toBe('lunes, 2 de marzo de 2026');
  });

  it('moves the day with the zone', () => {
    expect(formatDayLong('2026-03-03T02:00:00.000Z', 'America/Los_Angeles', 'en')).toBe('Monday, March 2, 2026');
    expect(formatDayLong('2026-03-03T02:00:00.000Z', 'Asia/Tokyo', 'en')).toBe('Tuesday, March 3, 2026');
  });
});

describe('formatTimeRange', () => {
  const start = '2026-03-02T14:30:00.000Z';
  const end = '2026-03-02T15:15:00.000Z';

  it('follows the 12h/24h choice', () => {
    expect(formatTimeRange(start, end, 'America/New_York', 'en', true)).toMatch(/^9:30\s*.\s*10:15\sAM$/);
    expect(formatTimeRange(start, end, 'America/New_York', 'en', false)).toMatch(/^09:30\s*.\s*10:15$/);
  });

  it('is in the zone it is asked for', () => {
    expect(formatTimeRange(start, end, 'UTC', 'en', false)).toMatch(/^14:30\s*.\s*15:15$/);
  });
});
