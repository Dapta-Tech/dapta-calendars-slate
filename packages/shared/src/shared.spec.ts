import { describe, it, expect } from 'vitest';
import { groupSlotsByDay } from './booking';
import { slugifyHandle, validateHandle } from './handle';
import { t } from './i18n';

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
