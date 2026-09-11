import { describe, expect, it } from 'vitest';
import { bookingPageStyleSchema } from '@slate/types';
import { DEFAULT_BOOKING_CANVAS, bookingCanvasOf } from './booking-canvas';

/**
 * The tenth axis's resolver (ADR 0004, B2 / #109).
 *
 * Small enough to look obvious, which is exactly why it is pinned: every
 * surface that paints a booking page reads this one function, so the value it
 * gives for an ABSENT axis is the appearance of every page saved before B2.
 */
describe('bookingCanvasOf', () => {
  it('resolves an absent axis to paper — the migration-free default', () => {
    expect(DEFAULT_BOOKING_CANVAS).toBe('light');
    expect(bookingCanvasOf(null)).toBe('light');
    expect(bookingCanvasOf(undefined)).toBe('light');
    expect(bookingCanvasOf({})).toBe('light');
    // A config saved before this axis existed: nine axes, no theme.
    expect(bookingCanvasOf({ template: 'split', corners: 'round', density: 'compact' })).toBe('light');
  });

  it('agrees with the contract about what the default is', () => {
    // Two declarations of one fact — the zod `.default()` and this constant —
    // so they are asserted equal rather than trusted to stay that way.
    expect(bookingPageStyleSchema.parse({}).theme).toBe(DEFAULT_BOOKING_CANVAS);
  });

  it('takes both stored values', () => {
    expect(bookingCanvasOf({ theme: 'dark' })).toBe('dark');
    expect(bookingCanvasOf({ theme: 'light' })).toBe('light');
  });

  it('falls back rather than throwing on a value the column should not hold', () => {
    // `booking_page_style` is jsonb read as an opaque record. A page rendered
    // for an invitee is the wrong place to discover that a row is malformed.
    for (const theme of ['auto', 'DARK', '', 0, true, null, {}, ['dark']]) {
      expect(bookingCanvasOf({ theme }), JSON.stringify(theme)).toBe('light');
    }
  });
});
