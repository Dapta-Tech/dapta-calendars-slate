import { describe, expect, it } from 'vitest';
import { dateLocale, formatBookingStart } from './booking-parts';

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
