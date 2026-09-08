import { describe, it, expect } from 'vitest';
import { groupSlotsByDay, isNavItemActive } from './booking';
import { isValidTimeZone, safeTimeZone } from './time';
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
