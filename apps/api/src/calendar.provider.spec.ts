import { describe, it, expect } from 'vitest';
import { loadServerEnv } from '@slate/config/env';
import { createCalendarProvider } from './calendar.provider';

describe('createCalendarProvider — env-selected port (E4/E5)', () => {
  it('defaults to the disabled OSS provider (no external calendar)', () => {
    const provider = createCalendarProvider(loadServerEnv({}));
    expect(provider.enabled).toBe(false);
  });

  it('CALENDAR_PROVIDER=disabled is the safe clone-and-run default', () => {
    const provider = createCalendarProvider(loadServerEnv({ CALENDAR_PROVIDER: 'disabled' }));
    expect(provider.enabled).toBe(false);
  });

  it('CALENDAR_PROVIDER=external fails loud without the private overlay', () => {
    expect(() => createCalendarProvider(loadServerEnv({ CALENDAR_PROVIDER: 'external' }))).toThrow(
      /overlay/i,
    );
  });
});
