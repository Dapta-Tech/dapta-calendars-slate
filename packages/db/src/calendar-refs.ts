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
import { normalizeAttendeeEmail } from './duplicate-guard';

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

/**
 * Every connection ref of every host a booking names: its organizer and any
 * co-host recorded in `booking_host`. Used to clear a display cache of busy
 * reads after a booking changes what those calendars hold, so it errs wide
 * (every calendar the hosts have connected, not only the conflict-checked
 * ones). Empty for an unknown uid or a booking whose hosts have no calendar.
 */
export async function loadBookingHostConnectionRefs(db: Db, uid: string): Promise<string[]> {
  const rows = await db.all<{ external_id: string }>(
    sql`SELECT DISTINCT cc.external_id FROM connected_calendar cc
        WHERE cc.member_id IN (
          SELECT b.host_member_id FROM booking b WHERE b.uid = ${uid} AND b.host_member_id IS NOT NULL
          UNION
          SELECT bh.member_id FROM booking_host bh JOIN booking b ON b.id = bh.booking_id WHERE b.uid = ${uid}
        )`,
  );
  return rows.map((r) => r.external_id);
}

// --- booking_reference (the persisted external event id per booking) --------

/** Everything the port needs to create/delete a booking's remote event. */
export interface CalendarWriteContext {
  bookingId: string;
  uid: string;
  /** The booking's account, for the settings the write depends on. Optional on
   *  this exported shape so a fixture built elsewhere still compiles. */
  accountId?: string;
  /**
   * How many people are on the booking besides its first invitee: extra
   * attendees and guests added later. This service emails none of them, so
   * while there are any the calendar provider's own invitation is their only
   * one. Optional like `accountId`; absent reads as none.
   */
  otherGuestCount?: number;
  title: string;
  /**
   * The event's body, rendered from the event type's description template
   * (`booking.calendar_description`). Null when there is none: the organizer's
   * event then has no description, as before templates existed, and a move
   * leaves the body alone. An empty string is a body this booking had and no
   * longer has (the template was removed or now renders nothing): a create
   * writes none, and a move clears it.
   */
  description: string | null;
  startUtc: string;
  endUtc: string;
  /** The human detail of the Where (address, number, custom label). */
  location: string | null;
  /**
   * B9: a conferencing link is requested when this is `'conferencing'`, or null
   * (the host set no location: an online meeting) — the kind snapshotted on the
   * booking, never a vendor literal (R15).
   */
  locationKind: LocationKind | null;
  attendeeTimeZone: string | null;
  /**
   * The guest list for the ORGANIZER's own event: the organizer first, then the
   * invitee(s), then any co-hosts, each address once. Use `attendeesFor(ctx,
   * ref)`, which picks this or `copyAttendeeEmails` by who owns the calendar.
   */
  attendeeEmails: string[];
  /**
   * The guest list for a CO-HOST's copy of the event: the invitee(s) and the
   * co-hosts, without the organizer. Listing the organizer on a co-host's copy
   * would invite them to a second copy of an event they already own.
   */
  copyAttendeeEmails: string[];
  /** The organizer's own calendars: today's destination and any other they
   *  have connected, so an event stored on a former destination stays theirs. */
  organizerDestinationRefs: string[];
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

/** Each address once, in first-seen order, compared as the duplicate guard does. */
function uniqueEmails(emails: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const email of emails) {
    const key = normalizeAttendeeEmail(email);
    if (!email || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(email);
  }
  return out;
}

/**
 * The guest list for the event written to `connectionRef`: the organizer-first
 * list on the organizer's own calendars, the co-host copy's list everywhere
 * else.
 */
export function attendeesFor(
  ctx: Pick<CalendarWriteContext, 'attendeeEmails' | 'copyAttendeeEmails' | 'organizerDestinationRefs'>,
  connectionRef: string | null | undefined,
): string[] {
  return connectionRef && ctx.organizerDestinationRefs.includes(connectionRef)
    ? ctx.attendeeEmails
    : ctx.copyAttendeeEmails;
}

/**
 * Load the booking + its attendees + host organizer email + destination refs
 * needed to write (or later delete) the external calendar event. Returns null
 * if the booking is gone.
 */
export async function loadBookingForCalendarWrite(db: Db, uid: string): Promise<CalendarWriteContext | null> {
  // Who is on the event BEFORE its text: a path that adds someone writes them
  // and the shared text in one transaction (`markSharedSql`), so every
  // attendee read here comes with a text at least that new. Read the other way
  // round, the first invitee's own text could be sent to a newcomer who joined
  // between the two reads.
  const attendees = await db.all<{ email: string }>(
    sql`SELECT email FROM booking_attendee WHERE booking_id = (SELECT id FROM booking WHERE uid = ${uid})
        UNION
        SELECT email FROM booking_guest WHERE booking_id = (SELECT id FROM booking WHERE uid = ${uid})`,
  );
  const b = await db.get<{
    id: string;
    account_id: string;
    uid: string;
    title: string;
    calendar_description: string | null;
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
    sql`SELECT b.id, b.account_id, b.uid, b.title, b.calendar_description, b.start_ms, b.end_ms, b.location,
               b.location_kind, b.attendee_time_zone,
               b.host_member_id, b.event_type_id, b.metadata, m.email AS host_email, m.locale AS host_locale
        FROM booking b
        LEFT JOIN member m ON m.id = b.host_member_id
        WHERE b.uid = ${uid} LIMIT 1`,
  );
  if (!b) return null;

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
  const organizerRefs = new Set<string>();
  const destinationCalendarIds: Record<string, string> = {};
  const metadata = parseJsonColumn<{
    _destinationCalendar?: { connectionRef?: string; externalId?: string };
  }>(b.metadata, {});
  const requestedDestination = metadata._destinationCalendar;
  if (isSingleHost && requestedDestination?.connectionRef && requestedDestination.externalId) {
    destinationSet.add(requestedDestination.connectionRef);
    organizerRefs.add(requestedDestination.connectionRef);
    destinationCalendarIds[requestedDestination.connectionRef] = requestedDestination.externalId;
  } else {
    for (const memberId of hostMemberIds) {
      const scopedEventTypeId = isSingleHost ? b.event_type_id : undefined;
      for (const ref of await loadDestinationConnectionRefs(db, memberId, scopedEventTypeId)) {
        destinationSet.add(ref);
        if (memberId === b.host_member_id) organizerRefs.add(ref);
      }
    }
  }

  // Which stored events are the organizer's own is a matter of whose calendar
  // holds them, not of today's destination: a host who switched destination
  // still owns the event written to the old one, and its reschedule must keep
  // them on it. So every calendar the organizer has connected counts, while
  // `destinationRefs` stays the calendars written to now.
  if (b.host_member_id) {
    const owned = await db.all<{ external_id: string }>(
      sql`SELECT external_id FROM connected_calendar WHERE member_id = ${b.host_member_id}`,
    );
    for (const row of owned) organizerRefs.add(row.external_id);
  }

  // Two guest lists, each address once (compared the way the duplicate guard
  // compares them). On the ORGANIZER's own event: the organizer first, then the
  // invitee(s), then any co-hosts, so the event shows its host (Google lists
  // the organizer among the guests only when the address is also an attendee).
  // That calendar is the organizer's own, and neither Google nor Microsoft
  // invites a calendar's own owner, so this adds no invite. On a CO-HOST's copy
  // the organizer is left off, or they would be invited to a second copy of an
  // event they already own; that copy keeps the list it always had.
  const coHostEmails = coHosts.map((h) => h.email).filter((e): e is string => !!e);
  const guestEmails = attendees.map((a) => a.email);
  const organizerKey = normalizeAttendeeEmail(b.host_email);
  const attendeeEmails = uniqueEmails([b.host_email, ...guestEmails, ...coHostEmails]);
  const copyAttendeeEmails = uniqueEmails([...guestEmails, ...coHostEmails]).filter(
    (e) => normalizeAttendeeEmail(e) !== organizerKey,
  );

  return {
    bookingId: b.id,
    accountId: b.account_id,
    // The organizer's own address among the attendees (a host who booked
    // themselves) is not a guest anyone has to invite.
    otherGuestCount: Math.max(
      0,
      uniqueEmails(guestEmails).filter((e) => normalizeAttendeeEmail(e) !== organizerKey).length - 1,
    ),
    uid: b.uid,
    title: b.title,
    description: b.calendar_description,
    startUtc: new Date(Number(b.start_ms)).toISOString(),
    endUtc: new Date(Number(b.end_ms)).toISOString(),
    location: b.location,
    locationKind: isLocationKind(b.location_kind) ? b.location_kind : null,
    attendeeTimeZone: b.attendee_time_zone,
    attendeeEmails,
    copyAttendeeEmails,
    organizerDestinationRefs: [...organizerRefs],
    organizerEmail: b.host_email,
    organizerLocale: b.host_locale,
    destinationRefs: [...destinationSet],
    destinationCalendarIds,
  };
}

/**
 * The two kinds of external record this table tracks. `calendar_event` is the
 * event written to a host's calendar; `crm` is the meeting written to the
 * account's CRM (H1a / #63). They share the table because they share ONE
 * guarantee — the `(booking_id, destination)` unique index that makes a retry
 * unable to create a duplicate — but they are addressed by different providers
 * and must never be handed to each other's.
 */
export type BookingReferenceType = 'calendar_event' | 'crm';

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
    type: BookingReferenceType;
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
 *
 * `type` defaults to `calendar_event`, which is the whole of what this table
 * held before H1a. The CRM write-out (#63) reuses this exact mechanism with
 * `type='crm'` and an `account_integration`-derived destination rather than
 * growing a second table: one guarantee, implemented once. A parallel copy of
 * this INSERT would put the no-duplicates promise in two places.
 */
export async function claimBookingDestination(
  db: Db,
  bookingId: string,
  destination: string,
  type: BookingReferenceType = 'calendar_event',
): Promise<string | null> {
  const id = randomUUID();
  try {
    await db.run(
      sql`INSERT INTO booking_reference (id, booking_id, destination, type, created_at)
          VALUES (${id}, ${bookingId}, ${destination}, ${type}, ${Date.now()})`,
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
 * Scoped to `calendar_event`: a conferencing room is the calendar's business,
 * and the CRM's row must not be written by the calendar path (see
 * `BookingReferenceType`).
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
    sql`UPDATE booking_reference SET meeting_url = ${meetingUrl}
        WHERE booking_id = ${bookingId} AND type = 'calendar_event'`,
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

/**
 * References for a booking, optionally narrowed to ONE kind.
 *
 * `type` is not optional in spirit: since H1a this table holds calendar events
 * AND CRM meetings, and a reader that takes both will hand a CRM meeting id to
 * the calendar provider. Every production caller passes a type; the parameter
 * stays optional only so a diagnostic can still see the whole set.
 */
export async function loadBookingReferences(
  db: Db,
  bookingId: string,
  type?: BookingReferenceType,
): Promise<BookingReferenceRow[]> {
  const rows = await db.all<{
    id: string;
    destination: string | null;
    type: string;
    external_event_id: string | null;
    external_calendar_id: string | null;
    meeting_url: string | null;
  }>(
    type
      ? sql`SELECT id, destination, type, external_event_id, external_calendar_id, meeting_url
            FROM booking_reference WHERE booking_id = ${bookingId} AND type = ${type}`
      : sql`SELECT id, destination, type, external_event_id, external_calendar_id, meeting_url
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

/**
 * Drop a booking's references once the remote records are gone. SCOPED BY TYPE:
 * the calendar teardown must not delete the CRM's row, which points at a meeting
 * that is PATCHed rather than deleted and is still needed to cancel it.
 */
export async function deleteBookingReferences(
  db: Db,
  bookingId: string,
  type?: BookingReferenceType,
): Promise<void> {
  await db.run(
    type
      ? sql`DELETE FROM booking_reference WHERE booking_id = ${bookingId} AND type = ${type}`
      : sql`DELETE FROM booking_reference WHERE booking_id = ${bookingId}`,
  );
}
