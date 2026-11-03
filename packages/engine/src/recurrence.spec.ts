import { describe, expect, it } from 'vitest';
import {
  addCivilDays,
  civilDayDiff,
  endedBefore,
  isOpenEnded,
  maxOccurrenceMinutes,
  recurrenceProblem,
  remainderRule,
  rruleFor,
  seriesOccurrences,
  seriesWallClockToUtc,
  shiftWeekdays,
  untilUtcFor,
  weekdayOf,
  type RecurrenceRule,
  type SeriesAnchor,
} from './recurrence';

const iso = (ms: number) => new Date(ms).toISOString();
const weekly = (over: Partial<RecurrenceRule> = {}): RecurrenceRule => ({
  frequency: 'weekly',
  interval: 1,
  weekdays: ['wednesday'],
  count: null,
  untilDate: null,
  ...over,
});
const phone: SeriesAnchor = { startDate: '2026-11-04', startTime: '15:30', durationMinutes: 30, timeZone: 'America/Bogota' };
const FAR = Date.parse('2030-01-01T00:00:00Z');

describe('seriesOccurrences', () => {
  it('a weekly Wednesday 15:30 in Bogota falls every Wednesday at 20:30 UTC', () => {
    const occ = seriesOccurrences(phone, weekly(), { toMs: FAR, max: 3 });
    expect(occ.map((o) => [o.index, o.date, iso(o.startMs), iso(o.endMs)])).toEqual([
      [0, '2026-11-04', '2026-11-04T20:30:00.000Z', '2026-11-04T21:00:00.000Z'],
      [1, '2026-11-11', '2026-11-11T20:30:00.000Z', '2026-11-11T21:00:00.000Z'],
      [2, '2026-11-18', '2026-11-18T20:30:00.000Z', '2026-11-18T21:00:00.000Z'],
    ]);
  });

  it('keeps the local time across a DST change (New York, autumn)', () => {
    const anchor: SeriesAnchor = { startDate: '2026-10-25', startTime: '09:00', durationMinutes: 60, timeZone: 'America/New_York' };
    const occ = seriesOccurrences(anchor, weekly({ weekdays: ['sunday'] }), { toMs: FAR, max: 2 });
    // 09:00 EDT (-4) then 09:00 EST (-5): the UTC hour moves, the wall clock does not.
    expect(occ.map((o) => iso(o.startMs))).toEqual(['2026-10-25T13:00:00.000Z', '2026-11-01T14:00:00.000Z']);
  });

  it('reads a skipped local time with the offset before the gap, as calendars do', () => {
    const anchor: SeriesAnchor = { startDate: '2027-03-13', startTime: '02:30', durationMinutes: 30, timeZone: 'America/New_York' };
    const occ = seriesOccurrences(anchor, { ...weekly(), frequency: 'daily', weekdays: [] }, { toMs: FAR, max: 3 });
    expect(occ.map((o) => iso(o.startMs))).toEqual([
      '2027-03-13T07:30:00.000Z', // 02:30 EST
      '2027-03-14T07:30:00.000Z', // 02:30 does not exist: 03:30 EDT
      '2027-03-15T06:30:00.000Z', // 02:30 EDT
    ]);
  });

  it('a time that happens twice is its first reading', () => {
    const at = seriesWallClockToUtc({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, 'America/New_York');
    expect(at.toISOString()).toBe('2026-11-01T05:30:00.000Z');
  });

  it('honours a count however late the window starts', () => {
    const rule = weekly({ count: 3 });
    const all = seriesOccurrences(phone, rule, { toMs: FAR });
    expect(all.map((o) => o.date)).toEqual(['2026-11-04', '2026-11-11', '2026-11-18']);
    const late = seriesOccurrences(phone, rule, { fromMs: Date.parse('2026-11-10T00:00:00Z'), toMs: FAR });
    expect(late.map((o) => [o.index, o.date])).toEqual([
      [1, '2026-11-11'],
      [2, '2026-11-18'],
    ]);
  });

  it('includes the until date and stops after it', () => {
    const occ = seriesOccurrences(phone, weekly({ untilDate: '2026-11-18' }), { toMs: FAR });
    expect(occ.map((o) => o.date)).toEqual(['2026-11-04', '2026-11-11', '2026-11-18']);
  });

  it('every other week on Monday and Wednesday counts weeks from the first week', () => {
    const anchor: SeriesAnchor = { ...phone, startDate: '2026-11-04' }; // a Wednesday
    const occ = seriesOccurrences(anchor, weekly({ interval: 2, weekdays: ['monday', 'wednesday'] }), { toMs: FAR, max: 4 });
    // Not Monday 11-02 (before the first date), then the week of 11-16.
    expect(occ.map((o) => o.date)).toEqual(['2026-11-04', '2026-11-16', '2026-11-18', '2026-11-30']);
  });

  it('daily every 3 days', () => {
    const occ = seriesOccurrences(phone, { ...weekly(), frequency: 'daily', weekdays: [], interval: 3 }, { toMs: FAR, max: 3 });
    expect(occ.map((o) => o.date)).toEqual(['2026-11-04', '2026-11-07', '2026-11-10']);
  });

  it('stops at the window end', () => {
    const occ = seriesOccurrences(phone, weekly(), { toMs: Date.parse('2026-11-18T20:30:00Z') });
    expect(occ.map((o) => o.date)).toEqual(['2026-11-04', '2026-11-11']);
  });
});

describe('rruleFor and untilUtcFor', () => {
  it('writes the weekly rule a calendar takes', () => {
    expect(rruleFor(phone, weekly())).toBe('FREQ=WEEKLY;INTERVAL=1;WKST=MO;BYDAY=WE');
    expect(rruleFor(phone, weekly({ count: 10, weekdays: ['wednesday', 'monday'] }))).toBe(
      'FREQ=WEEKLY;INTERVAL=1;WKST=MO;BYDAY=MO,WE;COUNT=10',
    );
    expect(rruleFor(phone, { ...weekly(), frequency: 'daily', weekdays: [], interval: 2 })).toBe('FREQ=DAILY;INTERVAL=2');
  });

  it('ends an until at the end of that day in the series zone, in UTC', () => {
    expect(untilUtcFor(phone, weekly({ untilDate: '2026-12-30' }))).toBe('20261231T045959Z');
    expect(rruleFor(phone, weekly({ untilDate: '2026-12-30' }))).toBe(
      'FREQ=WEEKLY;INTERVAL=1;WKST=MO;BYDAY=WE;UNTIL=20261231T045959Z',
    );
    expect(untilUtcFor(phone, weekly())).toBeNull();
  });
});

describe('recurrenceProblem', () => {
  it('accepts Felipe\'s weekly', () => {
    expect(recurrenceProblem(phone, weekly())).toBeNull();
  });

  it('refuses a first date that is not one of the weekdays', () => {
    expect(recurrenceProblem({ ...phone, startDate: '2026-11-05' }, weekly())).toMatch(/not one of the weekdays/);
  });

  it('refuses count and until together, a bad interval and occurrences that would touch', () => {
    expect(recurrenceProblem(phone, weekly({ count: 2, untilDate: '2026-12-01' }))).toMatch(/count or until/);
    expect(recurrenceProblem(phone, weekly({ interval: 0 }))).toMatch(/interval/);
    expect(recurrenceProblem({ ...phone, durationMinutes: 1440 }, { ...weekly(), frequency: 'daily', weekdays: [] })).toMatch(
      /run into the next/,
    );
    expect(recurrenceProblem(phone, weekly({ untilDate: '2026-11-01' }))).toMatch(/before the first date/);
    expect(recurrenceProblem({ ...phone, startTime: '25:00' }, weekly())).toMatch(/HH:mm/);
  });

  it('weekdays only for a weekly series', () => {
    expect(recurrenceProblem(phone, { ...weekly(), frequency: 'daily' })).toMatch(/only to a weekly/);
  });
});

describe('date helpers', () => {
  it('weekdays, day differences and shifts', () => {
    expect(weekdayOf('2026-11-04')).toBe('wednesday');
    expect(civilDayDiff('2026-11-04', '2026-11-11')).toBe(7);
    expect(addCivilDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftWeekdays(['sunday', 'wednesday'], 1)).toEqual(['monday', 'thursday']);
    expect(shiftWeekdays(['monday'], -1)).toEqual(['sunday']);
  });

  it('what is left of a series, and a series cut before a date', () => {
    expect(remainderRule(weekly({ count: 10 }), 4).count).toBe(6);
    expect(remainderRule(weekly(), 4).count).toBeNull();
    expect(endedBefore(weekly({ count: 10 }), '2026-11-18')).toMatchObject({ count: null, untilDate: '2026-11-17' });
    expect(isOpenEnded(weekly())).toBe(true);
    expect(isOpenEnded(weekly({ count: 2 }))).toBe(false);
  });

  it('the longest occurrence stays an hour short of the next', () => {
    expect(maxOccurrenceMinutes(weekly())).toBe(7 * 1440 - 60);
    expect(maxOccurrenceMinutes(weekly({ weekdays: ['monday', 'tuesday'] }))).toBe(1380);
    expect(maxOccurrenceMinutes({ ...weekly(), frequency: 'daily', weekdays: [], interval: 1 })).toBe(1380);
  });
});
