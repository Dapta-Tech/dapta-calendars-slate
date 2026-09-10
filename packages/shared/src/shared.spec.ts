import { describe, it, expect } from 'vitest';
import { buildMonthGrid, groupSlotsByDay, isNavItemActive, monthKeyOf, shiftMonth } from './booking';
import {
  formatSlotTime,
  isValidTimeZone,
  safeTimeZone,
  weekStartsOnFor,
  weekdayLabels,
  zonedTodayKey,
} from './time';
import { slugifyHandle, validateHandle } from './handle';
import { t, en, es } from './i18n';
import { phoneValidator, parseGuests, guestsValidator } from './booking-fields';
import { validateDayRanges, copyRangesToDays, daysToBlocks, blocksToDays } from './availability';
import { matchTheme, widgetStyleVars, THEME_PRESETS } from './branding';

// The colour half of the branding engine — the canvas-aware clamp and the
// ink/edge derivations — is specced in `branding.spec.ts`, which states each
// rule as a contrast law against a ground rather than as a fixed hex. What
// stays here is the part that has nothing to do with colour: the axis maps.
describe('branding engine', () => {
  it('widgetStyleVars maps corners/density to the exact radii/spacing', () => {
    const v = widgetStyleVars({ corners: 'round', density: 'compact', buttons: 'pill' });
    expect(v['--bp-radius']).toBe('28px');
    expect(v['--bp-btn-radius']).toBe('999px');
    expect(v['--bp-pad']).toBe('12px');
  });

  it('matchTheme derives the active theme from axes (not stored)', () => {
    expect(matchTheme(THEME_PRESETS.bold)).toBe('bold');
    expect(matchTheme({ ...THEME_PRESETS.bold, font: 'serif' })).toBeNull();
  });
});

describe('groupSlotsByDay', () => {
  it('buckets slots by the visitor day and labels local times', () => {
    const slots = [
      { startUtc: '2026-08-03T13:00:00.000Z' }, // 9:00 AM New_York
      { startUtc: '2026-08-03T13:30:00.000Z' },
      { startUtc: '2026-08-04T13:00:00.000Z' },
    ];
    const days = groupSlotsByDay(slots, 'America/New_York');
    expect(days).toHaveLength(2);
    expect(days[0]!.slots).toHaveLength(2);
    expect(days[0]!.slots[0]!.label).toMatch(/9:00/);
  });

  // The 12h/24h toggle (BP) rides the SAME grouping call, so the two views can
  // never disagree about which day a slot falls on — only about how it reads.
  it('labels slots in 12h or 24h on request, leaving the buckets alone', () => {
    const slots = [{ startUtc: '2026-08-03T17:30:00.000Z' }]; // 1:30 PM New_York
    const twelve = groupSlotsByDay(slots, 'America/New_York', { hour12: true });
    const twentyFour = groupSlotsByDay(slots, 'America/New_York', { hour12: false });
    expect(twelve[0]!.slots[0]!.label).toMatch(/1:30\s?PM/i);
    expect(twentyFour[0]!.slots[0]!.label).toBe('13:30');
    expect(twelve[0]!.dayKey).toBe(twentyFour[0]!.dayKey);
  });

  // `hour12: false` alone renders midnight as "24:00" on several locales; the
  // 24-hour clock people mean starts at 00.
  it('renders midnight as 00:xx in 24h, not 24:xx', () => {
    expect(formatSlotTime('2026-08-03T04:15:00.000Z', 'America/New_York', 'en-US', false)).toBe(
      '00:15',
    );
  });

  // A slot that crosses a DST boundary must keep its wall-clock label in both
  // formats — the platform's IANA database does the work, and the toggle must
  // not route around it.
  it('keeps wall-clock labels across a DST transition in both formats', () => {
    // 2026-11-01 is the US fall-back; 09:00 local is 13:00Z the day after.
    const before = '2026-10-31T13:00:00.000Z'; // EDT, UTC-4 -> 9:00 AM
    const after = '2026-11-01T14:00:00.000Z'; // EST, UTC-5 -> 9:00 AM
    expect(formatSlotTime(before, 'America/New_York', 'en-US', false)).toBe('09:00');
    expect(formatSlotTime(after, 'America/New_York', 'en-US', false)).toBe('09:00');
    expect(formatSlotTime(after, 'America/New_York', 'en-US', true)).toMatch(/9:00\s?AM/i);
  });
});

describe('month calendar grid (BP)', () => {
  it('lays a month out as whole weeks, borrowing neighbouring days', () => {
    // September 2026 starts on a Tuesday and has 30 days.
    const grid = buildMonthGrid('2026-09', { availableDayKeys: [], todayKey: '2026-09-10' });
    expect(grid.weeks.every((w) => w.length === 7)).toBe(true);
    expect(grid.weeks[0]![0]!.dayKey).toBe('2026-08-30'); // Sunday before the 1st
    expect(grid.weeks[0]![0]!.inMonth).toBe(false);
    expect(grid.weeks[0]![2]!.dayKey).toBe('2026-09-01');
    expect(grid.weeks.flat().filter((d) => d.inMonth)).toHaveLength(30);
    expect(grid.label).toBe('September 2026');
  });

  it('rotates the first column for a Monday-start locale', () => {
    const grid = buildMonthGrid('2026-09', {
      availableDayKeys: [],
      todayKey: '2026-09-10',
      locale: 'es',
      weekStartsOn: 1,
    });
    expect(grid.weeks[0]![0]!.dayKey).toBe('2026-08-31'); // the Monday before
    expect(grid.weeks[0]![1]!.dayKey).toBe('2026-09-01');
    // Spanish month names are lowercase; a heading gets an initial capital.
    expect(grid.label.startsWith('S')).toBe(true);
  });

  it('marks today, the past, and the days that actually have slots', () => {
    const grid = buildMonthGrid('2026-09', {
      availableDayKeys: new Set(['2026-09-11', '2026-09-14']),
      todayKey: '2026-09-10',
    });
    const byKey = new Map(grid.weeks.flat().map((d) => [d.dayKey, d]));
    expect(byKey.get('2026-09-10')!.isToday).toBe(true);
    expect(byKey.get('2026-09-10')!.isPast).toBe(false);
    expect(byKey.get('2026-09-09')!.isPast).toBe(true);
    expect(byKey.get('2026-09-11')!.hasSlots).toBe(true);
    expect(byKey.get('2026-09-12')!.hasSlots).toBe(false);
  });

  it('handles a month that starts on the first column and a leap February', () => {
    // February 2026 starts on a Sunday — no borrowed lead cells.
    const feb = buildMonthGrid('2026-02', { availableDayKeys: [], todayKey: '2026-02-01' });
    expect(feb.weeks[0]![0]!.dayKey).toBe('2026-02-01');
    expect(feb.weeks.flat().filter((d) => d.inMonth)).toHaveLength(28);
    const leap = buildMonthGrid('2028-02', { availableDayKeys: [], todayKey: '2028-02-01' });
    expect(leap.weeks.flat().filter((d) => d.inMonth)).toHaveLength(29);
  });

  it('shiftMonth rolls the year in both directions', () => {
    expect(shiftMonth('2026-09', 1)).toBe('2026-10');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-09', -13)).toBe('2025-08');
    expect(monthKeyOf('2026-09-10')).toBe('2026-09');
  });

  it('weekday headers start where the locale does', () => {
    expect(weekdayLabels('en-US', 0)).toHaveLength(7);
    expect(weekStartsOnFor('es')).toBe(1);
    expect(weekStartsOnFor('en')).toBe(0);
    // Rotating by one must move the first header to the second slot.
    const sunFirst = weekdayLabels('en-US', 0, 'short');
    const monFirst = weekdayLabels('en-US', 1, 'short');
    expect(monFirst[6]).toBe(sunFirst[0]);
  });

  // "Today" is the visitor's day, not the server's: a page rendered in New York
  // and read in Tokyo must not grey out the reader's current day.
  it('zonedTodayKey reads today in the visitor zone, not the runtime one', () => {
    const instant = new Date('2026-09-10T23:30:00.000Z');
    expect(zonedTodayKey('America/New_York', instant)).toBe('2026-09-10');
    expect(zonedTodayKey('Asia/Tokyo', instant)).toBe('2026-09-11');
  });
});

describe('isNavItemActive (admin shell)', () => {
  it('exact-matches the /admin root, prefix-matches others', () => {
    expect(isNavItemActive('/admin', '/admin')).toBe(true);
    expect(isNavItemActive('/admin/bookings', '/admin')).toBe(false); // root must not light up everywhere
    expect(isNavItemActive('/admin/bookings', '/admin/bookings')).toBe(true);
    expect(isNavItemActive('/admin/bookings/new', '/admin/bookings')).toBe(true);
    expect(isNavItemActive('/admin/event-types', '/admin/bookings')).toBe(false);
  });
  it('honours extra matches', () => {
    const m = ['/admin/settings'];
    expect(isNavItemActive('/admin/settings/general', '/admin/settings', m)).toBe(true);
    expect(isNavItemActive('/admin/teams', '/admin/settings', m)).toBe(false);
  });
  it('Calendars is a top-level item owning /admin/connections (not Settings)', () => {
    expect(isNavItemActive('/admin/connections', '/admin/connections')).toBe(true);
    expect(isNavItemActive('/admin/connections', '/admin/settings', ['/admin/settings'])).toBe(false);
  });
});

describe('handle', () => {
  it('slugifies and validates', () => {
    expect(slugifyHandle('Álex Rivera!')).toBe('alex-rivera');
    expect(validateHandle('alex-rivera')).toBeNull();
    expect(validateHandle('ab')).toBe('HANDLE_ERR_SHORT');
    expect(validateHandle('api')).toBe('HANDLE_ERR_RESERVED');
  });
});

describe('t', () => {
  it('interpolates placeholders', () => {
    expect(t('{minutes} min', { minutes: 30 })).toBe('30 min');
  });
});

describe('booking-fields validators (H5)', () => {
  it('phoneValidator accepts intl formats, rejects junk, allows empty', () => {
    expect(phoneValidator('')).toBeNull();
    expect(phoneValidator('+1 (555) 123-4567')).toBeNull();
    expect(phoneValidator('abc')).not.toBeNull();
  });
  it('parseGuests dedupes + lowercases; guestsValidator flags bad emails', () => {
    expect(parseGuests('A@x.com, a@x.com\n b@y.io')).toEqual(['a@x.com', 'b@y.io']);
    expect(guestsValidator('a@x.com, b@y.io')).toBeNull();
    expect(guestsValidator('a@x.com, nope')).toMatch(/valid email/);
  });
});

describe('availability-editor util (H1)', () => {
  it('validateDayRanges flags bad times, inverted, and overlaps', () => {
    expect(validateDayRanges([{ start: '09:00', end: '17:00' }])).toBeNull();
    expect(validateDayRanges([{ start: '17:00', end: '09:00' }])).not.toBeNull();
    expect(
      validateDayRanges([
        { start: '09:00', end: '12:00' },
        { start: '11:00', end: '13:00' },
      ]),
    ).toMatch(/overlap/);
  });
  it('copyRangesToDays clones one day into others; blocks round-trip', () => {
    const copied = copyRangesToDays({ 1: [{ start: '09:00', end: '17:00' }] }, 1, [2, 3]);
    expect(copied[2]).toEqual([{ start: '09:00', end: '17:00' }]);
    const blocks = daysToBlocks(copied);
    expect(blocksToDays(blocks)[3]).toEqual([{ start: '09:00', end: '17:00' }]);
  });
});

describe('i18n parity', () => {
  const keys = (o: Record<string, unknown>, prefix = ''): string[] =>
    Object.entries(o).flatMap(([k, v]) =>
      v && typeof v === 'object'
        ? keys(v as Record<string, unknown>, `${prefix}${k}.`)
        : [`${prefix}${k}`],
    );

  it('EN and ES have identical key sets (no missing translations)', () => {
    expect(keys(es as unknown as Record<string, unknown>).sort()).toEqual(
      keys(en as unknown as Record<string, unknown>).sort(),
    );
  });

  it('every message is a non-empty string in both locales', () => {
    for (const cat of [en, es]) {
      for (const k of keys(cat as unknown as Record<string, unknown>)) {
        const val = k.split('.').reduce<unknown>((o, part) => (o as Record<string, unknown>)[part], cat);
        expect(typeof val === 'string' && val.length > 0).toBe(true);
      }
    }
  });
});

describe('timezone validation (QA fix 1)', () => {
  it('accepts real IANA zones and common aliases', () => {
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('America/Phoenix')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
    expect(isValidTimeZone('US/Eastern')).toBe(true); // alias — must not be rejected
  });

  it('rejects garbage, empties, and non-strings', () => {
    expect(isValidTimeZone('UT}fg')).toBe(false); // the exact corrupt value from QA
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone('Not/AZone')).toBe(false);
    expect(isValidTimeZone(null)).toBe(false);
    expect(isValidTimeZone(undefined)).toBe(false);
    expect(isValidTimeZone(42)).toBe(false);
  });

  it('safeTimeZone falls back to UTC only when invalid', () => {
    expect(safeTimeZone('America/Bogota')).toBe('America/Bogota');
    expect(safeTimeZone('UT}fg')).toBe('UTC');
    expect(safeTimeZone(null)).toBe('UTC');
  });
});
