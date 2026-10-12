/**
 * What the manage link lets an invitee do with their booking.
 *
 * - `full`: an accepted booking still ahead. Move it or cancel it.
 * - `cancel`: a request still waiting on the host (the event type asks the host
 *   to confirm each booking). The invitee can withdraw it; the API has always
 *   allowed that (`cancelBooking` takes `pending`). Moving it is not offered:
 *   a new time is a new request, so they cancel and ask again.
 * - `none`: past, cancelled, declined, or a time the page cannot read.
 *
 * Before this, every status but `accepted` was `none`. A visitor who booked a
 * confirm-first event was told "We'll email you once it's confirmed", given a
 * "Manage your booking" link, and that link said the booking "can no longer be
 * changed": no way to withdraw a request they no longer wanted.
 */
export type ManageMode = 'full' | 'cancel' | 'none';

export function manageMode(status: string, startUtc: string | null, nowMs: number): ManageMode {
  if (startUtc === null || Date.parse(startUtc) <= nowMs) return 'none';
  if (status === 'accepted') return 'full';
  if (status === 'pending') return 'cancel';
  return 'none';
}
