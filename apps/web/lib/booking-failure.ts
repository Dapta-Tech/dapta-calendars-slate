/**
 * Which card a failed booking submit should render.
 *
 * Extracted from `booking-flow.tsx` because it is a DECISION, not markup, and
 * the decision is the part that has been wrong twice. The branches overlap on
 * status — the duplicate-booking guard and a taken slot are both `409`, a spent
 * invite link and an expired hold are both `410` — so the order they are tested
 * in is load-bearing, and a pure function is the only way to pin it.
 *
 * Every outcome here is a card with different advice. Getting it wrong does not
 * look like a bug: it tells a booker to do something that cannot possibly work
 * (pick another time, when the block is on their email or their invite link),
 * or it renders nothing at all and the submit appears to have been ignored.
 */

/** The shape `BookResult` presents once `ok` is false. */
export interface BookingFailure {
  status: number;
  error?: string;
}

export type BookingFailureKind =
  /** `409 DUPLICATE_BOOKING` — this email already holds an upcoming booking. */
  | 'duplicate'
  /** The one-off invite link is spent, revoked, or no longer opens this event. */
  | 'one-off-gone'
  /** A taken slot, an expired hold, or a calendar that could not be reached. */
  | 'conflict'
  /** `400` — a required intake answer is missing or malformed. */
  | 'intake'
  /** Anything else: the generic failure card. */
  | 'generic';

/**
 * `presentedOneOffToken` is what makes the `404` case decidable.
 *
 * A one-off failure that is not "spent" — a token naming nothing, or one that
 * no longer opens this event — answers a PLAIN `404 NOT_FOUND` with no error
 * code of its own. That is deliberate on the API side, so the public response
 * cannot be used to discover whether this deployment mints invite links at all
 * (see `booking.service.ts`; pinned in `apps/api/src/one-off-link.spec.ts`).
 *
 * The consequence is that the client cannot name that case from the body, only
 * from the status — and a bare `404` is only attributable to the link when this
 * page presented one. On a page that did, it also correctly catches the event
 * behind a live link being archived mid-form: the advice is the same either way,
 * which is to go back to whoever sent the link.
 */
export function classifyBookingFailure(
  result: BookingFailure,
  presentedOneOffToken: boolean,
): BookingFailureKind {
  // FIRST: the guard's 409 is not a taken slot. Left to fall through it would
  // offer "pick another time" for a block that is on the address, not the time.
  if (result.error === 'DUPLICATE_BOOKING') return 'duplicate';

  // SECOND, and before `conflict` for the same reason: a spent link's 410 is
  // not an expired hold. Retrying can never succeed, so the card carries no
  // action at all.
  if (result.error === 'ONE_OFF_GONE') return 'one-off-gone';
  if (presentedOneOffToken && result.status === 404) return 'one-off-gone';

  if (result.status === 409 || result.status === 410) return 'conflict';
  if (result.status === 400) return 'intake';
  return 'generic';
}
