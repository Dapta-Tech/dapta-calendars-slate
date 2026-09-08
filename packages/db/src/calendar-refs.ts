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
import { isLocationKind, type Interval, type LocationKind } from '@slate/engine';
import type { CalendarProvider } from '@slate/calendar';
import type { Db } from './client';
import { parseJsonColumn } from './repository';

/**
 * Connection refs used for CONFLICT checking (availability). Only calendars the
 * host opted into (`check_conflicts = 1`) contribute busy times. The ref is the
 * opaque `external_id` the provider round-trips — never an OAuth token.
 *
 * PHASE 2 (per-event calendars): when `eventTypeId` is given and the event has
 * an explicit `event_type_conflict_calendar` set, that set wins — ONLY calendars
 * belonging to `memberId` are ever considered (defense in depth: a per-event
 * override can never resolve to another member's calendar). Zero rows for the
 * event ⇒ fall back to the member-level default (unchanged behavior — a bare
 * event, or `eventTypeId` omitted, is exactly today's parity).
 */
export async function loadConflictConnectionRefs(
  db: Db,
  memberId: string,
  eventTypeId?: string | null,
): Promise<string[]> {
  if (eventTypeId) {
    const scoped = await db.all<{ external_id: string }>(
      sql`SELECT cc.external_id FROM event_type_conflict_calendar etcc
          JOIN connected_calendar cc ON cc.id = etcc.connected_calendar_id
          WHERE etcc.event_type_id = ${eventTypeId} AND cc.member_id = ${memberId}`,
    );
    if (scoped.length > 0) return scoped.map((r) => r.external_id);
  }
  const rows = await db.all<{ external_id: string }>(
    sql`SELECT external_id FROM connected_calendar
        WHERE member_id = ${memberId} AND check_conflicts = 1`,
  );
  return rows.map((r) => r.external_id);
}

/**
 * Connection refs that are WRITE destinations (`is_destination = 1`): where a
 * confirmed booking's event is created. Empty ⇒ nothing is written out.
 *
 * PHASE 2 (per-event calendars): when `eventTypeId` is given and the event has
 * an explicit `destination_calendar_id`, that SINGLE calendar wins — but only
 * if it still belongs to `memberId` (still connected, still theirs); a
 * disconnected/foreign reference is treated as unset and falls back to the
 * member-level default, same as `destination_calendar_id IS NULL`.
 */
export async function loadDestinationConnectionRefs(
  db: Db,
  memberId: string,
  eventTypeId?: string | null,
): Promise<string[]> {
  if (eventTypeId) {
    const et = await db.get<{ destination_calendar_id: string | null }>(
      sql`SELECT destination_calendar_id FROM event_type WHERE id = ${eventTypeId} LIMIT 1`,
    );
    if (et?.destination_calendar_id) {
      const cc = await db.get<{ external_id: string }>(
        sql`SELECT external_id FROM connected_calendar
            WHERE id = ${et.destination_calendar_id} AND member_id = ${memberId} LIMIT 1`,
      );
      if (cc) return [cc.external_id];
      // Referenced calendar disconnected or not owned by this member — fall
      // through to the member-level default below (never throw, never 500).
    }
  }
  // ORDER BY id: a partial unique index already caps this at one destination per
  // member, but `destinationRefs[0]` is now a documented contract (one
  // conferencing room, minted from the organizer's side) and a contract must not
  // rest on an unordered SELECT.
  const rows = await db.all<{ external_id: string }>(
    sql`SELECT external_id FROM connected_calendar
        WHERE member_id = ${memberId} AND is_destination = 1
        ORDER BY id`,
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
 *
 * `eventTypeId` threads the PHASE 2 per-event conflict-calendar override
 * through to `loadConflictConnectionRefs` — omit it (or pass null) for the
 * member-level default, exactly today's behavior.
 */
export async function loadExternalBusy(
  db: Db,
  calendar: CalendarProvider | undefined,
  memberId: string,
  fromMs: number,
  toMs: number,
  eventTypeId?: string | null,
): Promise<Interval[]> {
  if (!calendar?.enabled) return [];
  const connectionRefs = await loadConflictConnectionRefs(db, memberId, eventTypeId);
  if (connectionRefs.length === 0) return [];
  const busy = await calendar.listBusy({
    connectionRefs,
    fromUtc: new Date(fromMs).toISOString(),
    toUtc: new Date(toMs).toISOString(),
  });
  // The engine merges/sorts busy itself (computeSlots → mergeIntervals), so an
  // unsorted union is fine here.
  return busy.map((b) => ({
    start: new Date(b.startUtc),
    end: new Date(b.endUtc),
  }));
}

// --- booking_reference (the persisted external event id per booking) --------

/** Everything the port needs to create/delete a booking's remote event. */
export interface CalendarWriteContext {
  bookingId: string;
  uid: string;
  title: string;
  startUtc: string;
  endUtc: string;
  /** The human detail of the Where (address, number, custom label). */
  location: string | null;
  /**
   * B9: a conferencing link is requested when this is `'conferencing'` — the
   * kind snapshotted on the booking, never a vendor literal (R15).
   * Null on rows written before the kind existed.
   */
  locationKind: LocationKind | null;
  attendeeTimeZone: string | null;
  attendeeEmails: string[];
  organizerEmail: string | null;
  /** The organizer's locale — the co-hosts' event body is written in it. */
  organizerLocale: string | null;
  /**
   * Write-destination connection refs (`is_destination = 1`), **ordered with
   * the primary organizer's destinations first**.
   *
   * The order is a CONTRACT, not an accident of Set insertion: the conferencing
   * link is minted from `destinationRefs[0]` and only from there, so a team
   * booking gets exactly ONE room rather than one per host (#66). When the
   * primary host has no destination of their own, the first co-host's stands in
   * — still one room, which is what the invitee needs.
   */
  destinationRefs: string[];
  /** Optional provider calendar beneath each connection, selected by the v2 pilot. */
  destinationCalendarIds: Record<string, string>;
}

/**
 * Load the booking + its attendees + host organizer email + destination refs
 * needed to write (or later delete) the external calendar event. Returns null
 * if the booking is gone.
 */
export async function loadBookingForCalendarWrite(db: Db, uid: string): Promise<CalendarWriteContext | null> {
  const b = await db.get<{
    id: string;
    uid: string;
    title: string;
    start_ms: number;
    end_ms: number;
    location: string | null;
    location_kind: string | null;
    attendee_time_zone: string | null;
    host_member_id: string | null;
    event_type_id: string | null;
    host_email: string | null;
    host_locale: string | null;
    metadata: unknown;
  }>(
    sql`SELECT b.id, b.uid, b.title, b.start_ms, b.end_ms, b.location, b.location_kind, b.attendee_time_zone,
               b.host_member_id, b.event_type_id, b.metadata, m.email AS host_email, m.locale AS host_locale
        FROM booking b
        LEFT JOIN member m ON m.id = b.host_member_id
        WHERE b.uid = ${uid} LIMIT 1`,
  );
  if (!b) return null;
  const attendees = await db.all<{ email: string }>(
    sql`SELECT email FROM booking_attendee WHERE booking_id = ${b.id}
        UNION
        SELECT email FROM booking_guest WHERE booking_id = ${b.id}`,
  );

  // The assigned host set: co-hosts recorded in booking_host (collective /
  // fixed_round_robin) plus the primary organizer. Round-robin bookings have no
  // booking_host rows, so this is just the single host_member_id — behavior
  // unchanged. Each host's destination calendar gets the event; co-hosts are
  // added as attendees so everyone sees one shared event with all hosts on it.
  const coHosts = await db.all<{ member_id: string; email: string | null }>(
    sql`SELECT bh.member_id, m.email
        FROM booking_host bh LEFT JOIN member m ON m.id = bh.member_id
        WHERE bh.booking_id = ${b.id}`,
  );
  // ORDERED, organizer first — `destinationRefs`' documented contract depends on
  // it (one conferencing room per booking, minted from the organizer's side).
  // A plain array + dedupe rather than relying on Set insertion order being
  // obvious to the next reader.
  const hostMemberIds: string[] = [];
  const addHost = (id: string) => {
    if (!hostMemberIds.includes(id)) hostMemberIds.push(id);
  };
  if (b.host_member_id) addHost(b.host_member_id);
  for (const h of coHosts) addHost(h.member_id);

  // PHASE 2 (per-event calendars): the event's `destination_calendar_id`
  // override applies ONLY to genuinely single-host bookings (personal /
  // round-robin — no co-hosts recorded). Collective/fixed_round_robin team
  // bookings keep each host's own member-level default (Phase 3 territory);
  // applying one event-level override across multiple hosts' calendars would
  // be a silent wrong-calendar write.
  const isSingleHost = hostMemberIds.length <= 1;
  const destinationSet = new Set<string>();
  const destinationCalendarIds: Record<string, string> = {};
  const metadata = parseJsonColumn<{
    _destinationCalendar?: { connectionRef?: string; externalId?: string };
  }>(b.metadata, {});
  const requestedDestination = metadata._destinationCalendar;
  if (isSingleHost && requestedDestination?.connectionRef && requestedDestination.externalId) {
    destinationSet.add(requestedDestination.connectionRef);
    destinationCalendarIds[requestedDestination.connectionRef] = requestedDestination.externalId;
  } else {
    for (const memberId of hostMemberIds) {
      const scopedEventTypeId = isSingleHost ? b.event_type_id : undefined;
      for (const ref of await loadDestinationConnectionRefs(db, memberId, scopedEventTypeId)) {
        destinationSet.add(ref);
      }
    }
  }

  // On multi-host bookings the co-hosts join the invite as attendees (the
  // organizer is the booking's primary host, so exclude their email).
  const coHostEmails = coHosts.map((h) => h.email).filter((e): e is string => !!e && e !== b.host_email);
  const attendeeEmails = [...new Set([...attendees.map((a) => a.email), ...coHostEmails])].filter(Boolean);

  return {
    bookingId: b.id,
    uid: b.uid,
    title: b.title,
    startUtc: new Date(Number(b.start_ms)).toISOString(),
    endUtc: new Date(Number(b.end_ms)).toISOString(),
    location: b.location,
    locationKind: isLocationKind(b.location_kind) ? b.location_kind : null,
    attendeeTimeZone: b.attendee_time_zone,
    attendeeEmails,
    organizerEmail: b.host_email,
    organizerLocale: b.host_locale,
    destinationRefs: [...destinationSet],
    destinationCalendarIds,
  };
}

export interface BookingReferenceRow {
  id: string;
  destination: string | null;
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

/**
 * DH1 idempotency: atomically CLAIM a (booking_id, destination) slot before
 * creating the remote event. The UNIQUE index makes the INSERT the guard — a
 * retried or concurrent write loses the race and gets `null`, so it skips
 * createEvent and cannot produce a duplicate external event. Returns the new
 * reference id on success, or null if this destination is already claimed.
 */
export async function claimBookingDestination(
  db: Db,
  bookingId: string,
  destination: string,
): Promise<string | null> {
  const id = randomUUID();
  try {
    await db.run(
      sql`INSERT INTO booking_reference (id, booking_id, destination, type, created_at)
          VALUES (${id}, ${bookingId}, ${destination}, 'calendar_event', ${Date.now()})`,
    );
    return id;
  } catch {
    // Unique-violation (already claimed) — idempotent no-op.
    return null;
  }
}

/** Fill a claimed reference with the created event's ids once createEvent succeeds. */
export async function fillBookingReference(
  db: Db,
  referenceId: string,
  ref: {
    externalEventId: string;
    externalCalendarId: string | null;
    meetingUrl: string | null;
  },
): Promise<void> {
  await db.run(
    sql`UPDATE booking_reference
        SET external_event_id = ${ref.externalEventId},
            external_calendar_id = ${ref.externalCalendarId},
            meeting_url = ${ref.meetingUrl}
        WHERE id = ${referenceId}`,
  );
}

/**
 * Set ONLY the conferencing link on an existing reference.
 *
 * Distinct from `fillBookingReference`, which also rewrites the external ids:
 * a reschedule has an event id already and must not touch it. Used to persist a
 * URL a `moveEvent` returned, and to mirror the organizer's room onto co-host
 * rows so every reference for a booking names the same room.
 */
export async function setBookingReferenceMeetingUrl(
  db: Db,
  bookingId: string,
  meetingUrl: string,
): Promise<void> {
  await db.run(
    sql`UPDATE booking_reference SET meeting_url = ${meetingUrl} WHERE booking_id = ${bookingId}`,
  );
}

/**
 * Is a calendar write-out for this booking still in flight?
 *
 * The precise answer to "is it worth waiting for a link" (ADR 0007). It is
 * FALSE by construction on a bare fork — a disabled provider enqueues no
 * calendar row at all — and false once the job has finished or given up, so a
 * booking that can never receive a link is never delayed for one.
 */
export async function hasPendingCalendarJob(db: Db, uid: string): Promise<boolean> {
  const row = await db.get<{ n: number }>(
    sql`SELECT COUNT(*) AS n FROM outbox
        WHERE kind = 'calendar' AND booking_uid = ${uid} AND status = 'pending'`,
  );
  return Number(row?.n ?? 0) > 0;
}

/**
 * The booking's conferencing link, or null. ADR 0007: this is the ONE value an
 * email resolves at DELIVERY time rather than at enqueue — it is minted later,
 * by the calendar outbox row, so the enqueue-time snapshot cannot contain it.
 *
 * Every filled reference for a booking carries the same URL (write-out mints one
 * room and mirrors it in a single booking-wide UPDATE), so the value is the same
 * whichever row wins. `ORDER BY` is belt-and-braces: it keeps the read stable
 * even for rows written before that invariant held, so this reader, the manage
 * page and `/v1` cannot disagree about a legacy booking.
 */
export async function loadBookingMeetingUrl(db: Db, uid: string): Promise<string | null> {
  const row = await db.get<{ meeting_url: string | null }>(
    sql`SELECT br.meeting_url FROM booking_reference br
        JOIN booking b ON b.id = br.booking_id
        WHERE b.uid = ${uid} AND br.meeting_url IS NOT NULL
        ORDER BY br.created_at, br.id
        LIMIT 1`,
  );
  return row?.meeting_url ?? null;
}

/** Release a claim (e.g. createEvent failed) so a later retry can re-create it. */
export async function releaseBookingReference(db: Db, referenceId: string): Promise<void> {
  await db.run(sql`DELETE FROM booking_reference WHERE id = ${referenceId}`);
}

export async function loadBookingReferences(db: Db, bookingId: string): Promise<BookingReferenceRow[]> {
  const rows = await db.all<{
    id: string;
    destination: string | null;
    type: string;
    external_event_id: string | null;
    external_calendar_id: string | null;
    meeting_url: string | null;
  }>(
    sql`SELECT id, destination, type, external_event_id, external_calendar_id, meeting_url
        FROM booking_reference WHERE booking_id = ${bookingId}`,
  );
  return rows.map((r) => ({
    id: r.id,
    destination: r.destination,
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
