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
  it('resolves an absent axis to the console — the migration-free default', () => {
    // Paper until ADR 0004's 2026-09-11 amendment, which reversed it: the
    // product is dark and the booking page is part of the product. Almost no
    // config has an explicitly saved theme yet, so for nearly every live page
    // this is the value that decides what an invitee sees.
    expect(DEFAULT_BOOKING_CANVAS).toBe('dark');
    expect(bookingCanvasOf(null)).toBe('dark');
    expect(bookingCanvasOf(undefined)).toBe('dark');
    expect(bookingCanvasOf({})).toBe('dark');
    // A config saved before this axis existed: nine axes, no theme.
    expect(bookingCanvasOf({ template: 'split', corners: 'round', density: 'compact' })).toBe('dark');
  });

  it('agrees with the contract about what the default is', () => {
    // Two independent readers of one fact — the zod `.default()` in
    // @slate/types and `DEFAULT_BOOKING_THEME` in @slate/shared, which this
    // constant re-exports. This is the ONLY place both are reachable, so it is
    // the only place the parity can be asserted. A split between them is the
    // silent kind of bug: the contract parses one canvas while the engine
    // derives its tokens against the other, and nothing raises.
    expect(bookingPageStyleSchema.parse({}).theme).toBe(DEFAULT_BOOKING_CANVAS);
    expect(bookingPageStyleSchema.parse({}).theme).toBe('dark');
  });

  it('takes both stored values', () => {
    expect(bookingCanvasOf({ theme: 'dark' })).toBe('dark');
    expect(bookingCanvasOf({ theme: 'light' })).toBe('light');
  });

  it('falls back rather than throwing on a value the column should not hold', () => {
    // `booking_page_style` is jsonb read as an opaque record. A page rendered
    // for an invitee is the wrong place to discover that a row is malformed.
    for (const theme of ['auto', 'DARK', '', 0, true, null, {}, ['dark']]) {
      expect(bookingCanvasOf({ theme }), JSON.stringify(theme)).toBe('dark');
    }
  });
});
