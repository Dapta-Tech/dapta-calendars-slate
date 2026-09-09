import { sql } from 'drizzle-orm';
import type { Db } from './client';

/**
 * Duplicate-booking guard (#69, unit AB1 / #95).
 *
 * A per-event-type switch a host turns on: one normalized email may hold at
 * most one UPCOMING booking on that event type. It exists against the third of
 * three unrelated problems —
 *
 *   automated flood            → the per-IP RateLimitGuard, already shipped
 *   a link reaching strangers  → one-off links (AB2), a different mechanism
 *   one person hogging slots   → this
 *
 * — and it is emphatically **not a security control**. Email is verified
 * nowhere in this product (`cal-v2.service.ts` answers
 * `featureNotSupported("emailVerification")`), so anything keyed on an address
 * is walked around by a plus-tag or a throwaway inbox. It prevents accidents.
 * Keep that framing in any copy or comment that grows out of this file.
 *
 * Lives in its own module because the two public write paths it guards are in
 * two different files with two different outcome unions — `createBooking` in
 * `repository.ts` and `createTeamBooking` in `parity.ts`. One implementation,
 * two call sites, rather than the same query pasted twice.
 */

/**
 * The matching key: `lower(trim(email))` and nothing else.
 *
 * `+tags` are deliberately NOT stripped. Gmail folds `a+x@` and `a@` into one
 * mailbox; most providers do not, so collapsing them eventually blocks a
 * legitimately distinct person — a real cost for a defence a throwaway address
 * defeats anyway (#69).
 */
export function normalizeAttendeeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * `booking_attendee.email_normalized` is nullable: migrations land before the
 * API that writes it, so rows inserted in that window — and any row an
 * external writer creates — carry NULL. Reads coalesce onto the same
 * expression the column stores, so those rows still match.
 */
const normalizedEmailSql = sql`COALESCE(a.email_normalized, lower(trim(a.email)))`;

/**
 * True when `email` already holds an upcoming booking on `eventTypeId`.
 *
 * Counts `accepted` + `pending` with `end_ms > now`, so cancelling frees the
 * slot and a past booking never blocks a returning invitee (#69).
 *
 * Matches ANY `booking_attendee` row on the booking — the booker and the
 * co-attendees supplied at create time alike. `booking_attendee` carries no
 * `is_primary` marker and adding one would not be additive; the plain reading
 * of the switch ("this email already has an upcoming booking on this event")
 * is the one implemented. Guests added AFTER the fact live in `booking_guest`
 * and are deliberately out of scope, so being CC'd from the manage page never
 * blocks anyone.
 *
 * ADVISORY, and outside the write transaction on purpose: two simultaneous
 * submissions from one address can both pass. That is the same posture the
 * group-seat check one screen away already takes, and it is the right trade
 * for an opt-in limit over pre-existing data that may already violate it — a
 * UNIQUE/EXCLUDE constraint would fail the migration on live rows. It adds
 * nothing to, and takes nothing from, the double-booking guarantee: this runs
 * strictly before the overlap check and its transaction.
 */
export async function hasUpcomingBookingForEmail(
  db: Db,
  eventTypeId: string,
  email: string,
  now = Date.now(),
): Promise<boolean> {
  const normalized = normalizeAttendeeEmail(email);
  if (!normalized) return false;
  const hit = await db.get<{ id: string }>(
    sql`SELECT b.id FROM booking b
        WHERE b.event_type_id = ${eventTypeId}
          AND b.status IN ('accepted','pending')
          AND b.end_ms > ${now}
          AND EXISTS (
            SELECT 1 FROM booking_attendee a
             WHERE a.booking_id = b.id AND ${normalizedEmailSql} = ${normalized}
          )
        LIMIT 1`,
  );
  return !!hit;
}

/**
 * Whether the guard applies to THIS write at all.
 *
 * Two exemptions, each named after one of the two #69 wrote down, and both
 * explicit rather than inferred — the host is the party the limit protects, so
 * the host is never subject to it:
 *
 *   `onBehalf`    a host creating a booking from their own dashboard
 *   `apiKeyWrite` a server-side integration writing through the public API
 *
 * `onBehalf` alone would get this wrong. The cal.com-compatibility surface is
 * an API-key write that deliberately passes `onBehalf: false` (its bookings
 * are attributed to the invitee), and the team write path has no `onBehalf`
 * argument at all — so keying only on it would leave both of those guarded,
 * contradicting the decision.
 */
export function duplicateGuardApplies(opts: {
  preventDuplicateBookings: number | boolean | null | undefined;
  onBehalf?: boolean;
  apiKeyWrite?: boolean;
}): boolean {
  if (opts.onBehalf || opts.apiKeyWrite) return false;
  return !!opts.preventDuplicateBookings;
}
