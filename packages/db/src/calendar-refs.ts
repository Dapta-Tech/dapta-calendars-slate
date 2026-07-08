/**
 * The seam between the booking data layer and the CalendarProvider PORT
 * (`@slate/calendar`). This module owns everything the port needs from the DB:
 *   - which connection refs feed conflict-checking (availability busy-subtraction)
 *   - which connection refs are write destinations (event write-out)
 *   - the `booking_reference` table (the external event id we persist per booking)
 *
 * It depends ONLY on the port INTERFACE — never a concrete adapter, never a
 * vendor name (R15). The OSS default provider is disabled, so every function
 * here is a no-op on a bare clone: no connections rows ⇒ no external busy and no
 * write-out. A private overlay swaps in a real provider without touching this.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Interval } from '@slate/engine';
import type { CalendarProvider } from '@slate/calendar';
import type { Db } from './client';

/**
 * Connection refs used for CONFLICT checking (availability). Only calendars the
 * host opted into (`check_conflicts = 1`) contribute busy times. The ref is the
 * opaque `external_id` the provider round-trips — never an OAuth token.
 */
export async function loadConflictConnectionRefs(db: Db, memberId: string): Promise<string[]> {
  const rows = await db.all<{ external_id: string }>(
    sql`SELECT external_id FROM connected_calendar
        WHERE member_id = ${memberId} AND check_conflicts = 1`,
  );
  return rows.map((r) => r.external_id);
}

/**
 * Connection refs that are WRITE destinations (`is_destination = 1`): where a
 * confirmed booking's event is created. Empty ⇒ nothing is written out.
 */
export async function loadDestinationConnectionRefs(db: Db, memberId: string): Promise<string[]> {
  const rows = await db.all<{ external_id: string }>(
    sql`SELECT external_id FROM connected_calendar
        WHERE member_id = ${memberId} AND is_destination = 1`,
  );
  return rows.map((r) => r.external_id);
}

/**
 * The host's external busy times over [fromMs,toMs), fetched via the port and
 * projected to engine `Interval`s to be UNIONed with local booking/hold busy.
 *
 * Strict no-op contract (keeps clone-and-run behavior identical to before):
 *   - `calendar` undefined or `enabled === false` (the OSS DisabledProvider) → []
 *   - no conflict-checked connections → [] (never calls the provider)
 */
export async function loadExternalBusy(
  db: Db,
  calendar: CalendarProvider | undefined,
  memberId: string,
  fromMs: number,
  toMs: number,
): Promise<Interval[]> {
  if (!calendar?.enabled) return [];
  const connectionRefs = await loadConflictConnectionRefs(db, memberId);
  if (connectionRefs.length === 0) return [];
  const busy = await calendar.listBusy({
    connectionRefs,
    fromUtc: new Date(fromMs).toISOString(),
    toUtc: new Date(toMs).toISOString(),
  });
  // The engine merges/sorts busy itself (computeSlots → mergeIntervals), so an
  // unsorted union is fine here.
  return busy.map((b) => ({ start: new Date(b.startUtc), end: new Date(b.endUtc) }));
}

// --- booking_reference (the persisted external event id per booking) --------

/** Everything the port needs to create/delete a booking's remote event. */
export interface CalendarWriteContext {
  bookingId: string;
  uid: string;
  title: string;
  startUtc: string;
  endUtc: string;
  /** B9: a Meet link is requested when this is exactly `'google_meet'`. */
  location: string | null;
  attendeeTimeZone: string | null;
  attendeeEmails: string[];
  organizerEmail: string | null;
  /** Write-destination connection refs (`is_destination = 1`). */
  destinationRefs: string[];
}

/**
 * Load the booking + its attendees + host organizer email + destination refs
 * needed to write (or later delete) the external calendar event. Returns null
 * if the booking is gone.
 */
export async function loadBookingForCalendarWrite(
  db: Db,
  uid: string,
): Promise<CalendarWriteContext | null> {
  const b = await db.get<{
    id: string;
    uid: string;
    title: string;
    start_ms: number;
    end_ms: number;
    location: string | null;
    attendee_time_zone: string | null;
    host_member_id: string | null;
    host_email: string | null;
  }>(
    sql`SELECT b.id, b.uid, b.title, b.start_ms, b.end_ms, b.location, b.attendee_time_zone,
               b.host_member_id, m.email AS host_email
        FROM booking b
        LEFT JOIN member m ON m.id = b.host_member_id
        WHERE b.uid = ${uid} LIMIT 1`,
  );
  if (!b) return null;
  const attendees = await db.all<{ email: string }>(
    sql`SELECT email FROM booking_attendee WHERE booking_id = ${b.id}`,
  );
  const destinationRefs = b.host_member_id
    ? await loadDestinationConnectionRefs(db, b.host_member_id)
    : [];
  return {
    bookingId: b.id,
    uid: b.uid,
    title: b.title,
    startUtc: new Date(Number(b.start_ms)).toISOString(),
    endUtc: new Date(Number(b.end_ms)).toISOString(),
    location: b.location,
    attendeeTimeZone: b.attendee_time_zone,
    attendeeEmails: attendees.map((a) => a.email).filter(Boolean),
    organizerEmail: b.host_email,
    destinationRefs,
  };
}

export interface BookingReferenceRow {
  id: string;
  type: string;
  externalEventId: string | null;
  externalCalendarId: string | null;
  meetingUrl: string | null;
}

/**
 * Persist the external event id returned by the port. `externalCalendarId`
 * carries the connection ref used to create it, so a later delete can address
 * the same connection without re-resolving destinations.
 */
export async function writeBookingReference(
  db: Db,
  ref: {
    bookingId: string;
    type: string;
    externalEventId: string;
    externalCalendarId: string | null;
    meetingUrl: string | null;
  },
): Promise<void> {
  await db.run(
    sql`INSERT INTO booking_reference
          (id, booking_id, type, external_event_id, external_calendar_id, meeting_url, created_at)
        VALUES (${randomUUID()}, ${ref.bookingId}, ${ref.type}, ${ref.externalEventId},
          ${ref.externalCalendarId}, ${ref.meetingUrl}, ${Date.now()})`,
  );
}

export async function loadBookingReferences(
  db: Db,
  bookingId: string,
): Promise<BookingReferenceRow[]> {
  const rows = await db.all<{
    id: string;
    type: string;
    external_event_id: string | null;
    external_calendar_id: string | null;
    meeting_url: string | null;
  }>(
    sql`SELECT id, type, external_event_id, external_calendar_id, meeting_url
        FROM booking_reference WHERE booking_id = ${bookingId}`,
  );
  return rows.map((r) => ({
    id: r.id,
    type: r.type,
    externalEventId: r.external_event_id,
    externalCalendarId: r.external_calendar_id,
    meetingUrl: r.meeting_url,
  }));
}

/** Drop all references for a booking once the remote events are deleted. */
export async function deleteBookingReferences(db: Db, bookingId: string): Promise<void> {
  await db.run(sql`DELETE FROM booking_reference WHERE booking_id = ${bookingId}`);
}
