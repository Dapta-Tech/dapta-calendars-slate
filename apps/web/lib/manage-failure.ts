import type { BookingMessages } from '@slate/shared';

/** What a manage action (reschedule, cancel) answered when it did not go through. */
export interface ManageFailure {
  status?: number;
  error?: string;
}

/**
 * The sentence the manage page shows for a reschedule or cancel that did not
 * go through, in the visitor's language. The API's own `message` is English
 * and written for integrators, so the page decides from the code and the
 * status instead, and every line says what to do next.
 */
export function manageFailureCopy(r: ManageFailure, messages: BookingMessages): string {
  const copy = messages.trouble;
  if (r.error === 'NO_TIME') return copy.pickTime;
  if (r.status === 429) return copy.actionBusy;
  if (r.error === 'CALENDAR_UNAVAILABLE') return copy.actionCalendar;
  if (r.error === 'SLOT_TAKEN') return copy.actionTaken;
  if (r.error === 'INVALID_SLOT') return copy.actionUnavailable;
  if (r.error === 'GONE' || r.status === 410) return messages.manage.cannotChange;
  if (r.error === 'FORBIDDEN' || r.status === 403 || r.status === 404) return copy.actionLinkDead;
  return copy.actionFailed;
}

/**
 * Whether the same request may simply be sent again: the service was busy, or
 * the host's calendar could not be read just then. The page then keeps the
 * visitor's choice in place, so pressing the button again is the retry.
 */
export function manageFailureIsRetryable(r: ManageFailure): boolean {
  return r.status === 429 || r.error === 'CALENDAR_UNAVAILABLE';
}
