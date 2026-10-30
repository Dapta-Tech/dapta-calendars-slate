import { describe, it, expect } from 'vitest';
import { wantsConferencingLink } from './email-effects';

/**
 * Which bookings carry a join link (F4 of the 2026-10-30 production E2E): one
 * rule shared by the calendar write and the email outbox, so they can never
 * disagree.
 */
describe('wantsConferencingLink', () => {
  it('an online meeting, or no location at all, carries a link', () => {
    expect(wantsConferencingLink('conferencing')).toBe(true);
    expect(wantsConferencingLink(null)).toBe(true);
    expect(wantsConferencingLink('')).toBe(true);
  });

  it('a place, a phone number, or a row queued before the kind existed does not', () => {
    for (const kind of ['in_person', 'phone', 'link', 'custom']) expect(wantsConferencingLink(kind), kind).toBe(false);
    expect(wantsConferencingLink(undefined)).toBe(false);
  });

  it('no kind but an address (a booking written before kinds) is not an online meeting', () => {
    expect(wantsConferencingLink(null, '12 Main St')).toBe(false);
    expect(wantsConferencingLink(null, '   ')).toBe(true);
    expect(wantsConferencingLink('conferencing', 'Zoom room 4')).toBe(true);
  });
});
