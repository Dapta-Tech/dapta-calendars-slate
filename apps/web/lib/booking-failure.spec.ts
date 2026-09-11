import { describe, expect, it } from 'vitest';
import { classifyBookingFailure } from './booking-failure';

/**
 * The booking-failure card matrix.
 *
 * The branches OVERLAP on status, so these tests are really about ORDER: 409 is
 * both a taken slot and the duplicate guard, and 410 is both an expired hold and
 * a spent invite link. Each wrong answer shows a booker advice that cannot work.
 */
describe('classifyBookingFailure', () => {
  it('puts the duplicate guard ahead of the taken-slot 409', () => {
    // Same status, different cause. "Pick another time" is useless when the
    // block is on the address.
    expect(classifyBookingFailure({ status: 409, error: 'DUPLICATE_BOOKING' }, false)).toBe(
      'duplicate',
    );
    expect(classifyBookingFailure({ status: 409, error: 'SLOT_TAKEN' }, false)).toBe('conflict');
  });

  it('puts a spent invite link ahead of the expired-hold 410', () => {
    expect(classifyBookingFailure({ status: 410, error: 'ONE_OFF_GONE' }, true)).toBe(
      'one-off-gone',
    );
    expect(classifyBookingFailure({ status: 410, error: 'RESERVATION_EXPIRED' }, true)).toBe(
      'conflict',
    );
  });

  /**
   * THE ONE THAT WAS BROKEN. An earlier revision matched this case on
   * `error === 'ONE_OFF_NOT_FOUND'`, which never crosses the wire: the API
   * folds it into a plain `NOT_FOUND` so the response is not an oracle for
   * whether invite links exist. The branch was therefore dead and a 404 fell
   * through to no card at all — the submit looked ignored.
   */
  it('attributes a bare 404 to the link when this page presented one', () => {
    expect(classifyBookingFailure({ status: 404, error: 'NOT_FOUND' }, true)).toBe('one-off-gone');
    // No error code at all is the same case — only the status is dependable.
    expect(classifyBookingFailure({ status: 404 }, true)).toBe('one-off-gone');
  });

  it('does NOT attribute a 404 to a link on a page that presented none', () => {
    // An ordinary public booking page has no grant to blame, so a 404 there is
    // the generic failure it has always been.
    expect(classifyBookingFailure({ status: 404, error: 'NOT_FOUND' }, false)).toBe('generic');
  });

  it('keeps the duplicate guard ahead of the link even on a one-off page', () => {
    // Both can be true at once: an invite link over an event whose host also
    // switched the duplicate guard on. The address block is the actionable one
    // — the booker can use a different email — so it wins.
    expect(classifyBookingFailure({ status: 409, error: 'DUPLICATE_BOOKING' }, true)).toBe(
      'duplicate',
    );
  });

  it('routes intake and everything else unchanged', () => {
    expect(classifyBookingFailure({ status: 400, error: 'INTAKE_INVALID' }, true)).toBe('intake');
    expect(classifyBookingFailure({ status: 500 }, true)).toBe('generic');
    expect(classifyBookingFailure({ status: 503, error: 'ERROR' }, false)).toBe('generic');
  });

  it('treats a 409 CALENDAR_UNAVAILABLE as a conflict, not a link failure', () => {
    // Fail-closed calendar handling keeps its own copy inside the conflict card.
    expect(classifyBookingFailure({ status: 409, error: 'CALENDAR_UNAVAILABLE' }, true)).toBe(
      'conflict',
    );
  });
});
