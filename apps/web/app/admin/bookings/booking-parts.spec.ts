import { describe, expect, it } from 'vitest';
import { getMessages } from '@slate/shared';
import { dateLocale, formatBookingStart, repeatsText } from './booking-parts';

/**
 * A booking's date in the dashboard is written in the reader's language: the
 * list, a booking's own page and the new-booking form's times all format
 * through `dateLocale`.
 */
describe("a booking's date in the dashboard", () => {
  const start = '2026-11-19T23:00:00.000Z';

  it('stays the US English it always was for an English reader', () => {
    expect(formatBookingStart(start, 'America/Bogota')).toBe('Thu, Nov 19, 6:00 PM GMT-5');
    expect(formatBookingStart(start, 'America/Bogota', 'en')).toBe('Thu, Nov 19, 6:00 PM GMT-5');
    expect(dateLocale('en')).toBe('en-US');
  });

  it('is Spanish for a Spanish reader, in the same zone', () => {
    expect(formatBookingStart(start, 'America/Bogota', 'es')).toBe('jue, 19 nov, 18:00 GMT-5');
    expect(dateLocale('es')).toBe('es');
  });
});

/** A date of a repeating event (ADR 0012) says how it repeats, in the reader's language. */
describe('how a repeating event repeats', () => {
  const weekly = {
    seriesId: 's1',
    frequency: 'weekly' as const,
    interval: 1,
    weekdays: ['wednesday'],
    count: null,
    untilDate: null,
    startTime: '15:30',
    timeZone: 'America/Bogota',
    status: 'active',
  };

  it('in English', () => {
    const m = getMessages('en').admin.bookings;
    expect(repeatsText(weekly, m, 'en')).toBe('Every Wednesday at 15:30, no end date (America/Bogota)');
    expect(repeatsText({ ...weekly, interval: 2, weekdays: ['monday', 'wednesday'], count: 10 }, m, 'en')).toBe(
      'Every 2 weeks on Monday and Wednesday at 15:30, 10 times (America/Bogota)',
    );
    expect(repeatsText({ ...weekly, frequency: 'daily', weekdays: [], untilDate: '2027-01-31' }, m, 'en')).toBe(
      'Every day at 15:30, until 2027-01-31 (America/Bogota)',
    );
  });

  it('in Spanish', () => {
    const m = getMessages('es').admin.bookings;
    expect(repeatsText(weekly, m, 'es')).toBe('Cada miércoles a las 15:30, sin fecha de fin (America/Bogota)');
  });
});
