import { enqueueWebhookDeliveries, getBookingUtm, type Db } from '@slate/db';
import type { BookingUtm } from '@slate/types';

/**
 * The `data` of every booking webhook (`booking.created`, `booking.confirmed`,
 * `booking.rescheduled`, `booking.cancelled`): the booking's `uid`, what the
 * event adds (times, title, status, a reason, the uid it moved from), and
 * `utm`, the campaign the booking came from. That is the stored `booking.utm`,
 * the `utm_*` keys it kept (`BOOKING_UTM_KEYS`), or null when it has none.
 * Always present, so a subscriber reads one shape whichever event it got.
 *
 * ```json
 * { "event": "booking.created",
 *   "data": { "uid": "...", "status": "accepted", "startUtc": "...", "endUtc": "...",
 *             "title": "Intro Call", "utm": { "utm_source": "newsletter", "utm_campaign": "q4" } } }
 * ```
 */
export type BookingWebhookData = { uid: string; utm: BookingUtm | null } & Record<string, unknown>;

/**
 * Enqueue one booking lifecycle webhook with the booking's campaign on it. A
 * caller that already holds the campaign passes it as `utm` (the create paths,
 * right after writing it); any other reads it from the booking. A failed read
 * sends `utm: null` rather than no event: the campaign is attribution, never a
 * reason to drop a delivery.
 */
export async function enqueueBookingWebhook(
  db: Db,
  accountId: string,
  event: string,
  data: { uid: string; utm?: BookingUtm | null } & Record<string, unknown>,
): Promise<number> {
  const utm = data.utm !== undefined ? data.utm : await getBookingUtm(db, data.uid).catch(() => null);
  const payload: BookingWebhookData = { ...data, utm };
  return enqueueWebhookDeliveries(db, accountId, event, payload);
}
