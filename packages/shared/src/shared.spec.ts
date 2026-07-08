import { describe, it, expect } from 'vitest';
import { groupSlotsByDay } from './booking';
import { slugifyHandle, validateHandle } from './handle';
import { t } from './i18n';
import {
  clampAccent,
  accentWasAdjusted,
  matchTheme,
  widgetStyleVars,
  THEME_PRESETS,
  DEFAULT_ACCENT,
} from './branding';

describe('branding engine', () => {
  it('AA-clamps a too-dark accent lighter, leaves a safe one', () => {
    // Near-black gets nudged lighter (adjusted); the DS lime is already safe.
    expect(accentWasAdjusted('#000000')).toBe(true);
    expect(clampAccent('#000000')).not.toBe('#000000');
    expect(accentWasAdjusted(DEFAULT_ACCENT)).toBe(false);
    // Unparseable falls back to the DS accent.
    expect(clampAccent('nope')).toBe(DEFAULT_ACCENT);
  });

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
