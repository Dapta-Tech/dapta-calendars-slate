/**
 * The booking repository — the only place that turns the portable schema into
 * domain operations. Reads compose the pure @slate/engine (slot computation);
 * the write path (createBooking) enforces the anti-double-booking guarantee with
 * dual enforcement: an app-level overlap-check-in-a-transaction on BOTH engines
 * (the only backstop on SQLite), plus the DB-level EXCLUDE on Postgres (caught
 * as a 23P01 → conflict). See migration plan §5.
 */
import { randomUUID } from 'node:crypto';
import { sql, type SQL } from 'drizzle-orm';
import {
  classifyEmptyReason,
  computeSlots,
  generateManageToken,
  isOneOffTokenShape,
  isExclusionViolation,
  isUniqueViolation,
  parseEventLocation,
  plainCalendarTitle,
  type AvailabilityEmptyReason,
  type AvailabilityRule,
  type EventLocation,
  type Interval,
} from '@slate/engine';
import type { CalendarProvider } from '@slate/calendar';
import { normalizeEventTracking, type EventTracking } from '@slate/types';
import type { Db } from './client';
import { loadExternalBusy } from './calendar-refs';
import { applyCalendarTemplates, applySharedFallback, markSharedSql } from './calendar-text';
import { canonicalPublicCode } from './short-links';
import {
  duplicateGuardApplies,
  hasUpcomingBookingForEmail,
  normalizeAttendeeEmail,
  normalizedEmailSql,
} from './duplicate-guard';
import {
  consumeOneOffLink,
  getOneOffLinkByToken,
  oneOffGuardApplies,
  type OneOffLinkRecord,
} from './one-off-link';

/**
 * Read a JSON column uniformly: Postgres jsonb comes back parsed (object),
 * SQLite text comes back as a string. Returns `fallback` for null/empty.
 */
export function parseJsonColumn<T>(value: unknown, fallback: T): T {
  if (value == null || value === '') return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

/**
 * The addresses on the bookings `bookingWhere` selects (a condition on the
 * booking aliased `b`), by their normalized column: the attendees as the
 * duplicate guard reads them (`normalizedEmailSql`), the guests as their
 * unique key does. Read through `peopleOn`, never counted as rows: one person
 * can be listed in more than one place.
 *
 * @internal Shared by every count and dedupe of a booking's people.
 */
export function peopleRowsSql(bookingWhere: SQL) {
  return sql`SELECT a.booking_id AS booking_id, ${normalizedEmailSql} AS email
        FROM booking_attendee a JOIN booking b ON b.id = a.booking_id WHERE ${bookingWhere}
      UNION ALL
      SELECT g.booking_id AS booking_id, g.email_normalized AS email
        FROM booking_guest g JOIN booking b ON b.id = g.booking_id WHERE ${bookingWhere}`;
}

/**
 * Everyone on one booking, each person once: its attendee and guest rows
 * (`peopleRowsSql`) and the guests a v2 booking names in its metadata, who are
 * also its attendee rows. Each address goes through `normalizeAttendeeEmail`
 * again, since SQL's `lower` and `trim` fold less than it does on some
 * engines; an address that normalizes to nothing is nobody. The seats of a
 * group slot, its holds and the add paths' cap and dedupe all read this set.
 *
 * @internal Shared by every count and dedupe of a booking's people.
 */
export function peopleOn(rows: ReadonlyArray<{ email: string | null }>, metadata: unknown): Set<string> {
  const named = parseJsonColumn<{ _guests?: unknown[] }>(metadata, {})._guests ?? [];
  return new Set(
    [...rows.map((r) => r.email), ...(Array.isArray(named) ? named : [])]
      .map((email) => normalizeAttendeeEmail(typeof email === 'string' ? email : null))
      .filter((email) => email !== ''),
  );
}

/**
 * `peopleRowsSql` rows read for several bookings at once, grouped by booking,
 * so each booking's `peopleOn` reads only its own rows.
 *
 * @internal Shared by the reads that count several bookings' people.
 */
export function peopleRowsByBooking<T extends { booking_id: string }>(rows: readonly T[]): Map<string, T[]> {
  const byBooking = new Map<string, T[]>();
  for (const row of rows) {
    const list = byBooking.get(row.booking_id);
    if (list) list.push(row);
    else byBooking.set(row.booking_id, [row]);
  }
  return byBooking;
}

/** Build a JSON write value: cast text → jsonb on Postgres, bind text on SQLite. */
export function jsonParam(db: Db, value: unknown) {
  const text = value == null ? null : JSON.stringify(value);
  if (text == null) return sql`NULL`;
  return db.dialect === 'postgres' ? sql`${text}::jsonb` : sql`${text}`;
}

export interface AccountRow {
  id: string;
  /** The canonical short code (or a legacy pretty code like the seeded `acme`). */
  code: string;
  name: string;
  /** Premium vanity slug; when set it is the canonical PUBLIC code. */
  vanity_slug: string | null;
}
export interface MemberRow {
  id: string;
  account_id: string;
  handle: string | null;
  display_name: string | null;
  email: string | null;
  avatar_url: string | null;
  cover_url: string | null;
  brand_color: string | null;
  layout: string | null;
  booking_page_style: unknown;
  time_zone: string;
  default_schedule_id: string | null;
}
export interface EventTypeRow {
  id: string;
  account_id: string;
  member_id: string | null;
  team_id: string | null;
  slug: string;
  title: string;
  description: string | null;
  length_minutes: number;
  locations: unknown;
  schedule_id: string | null;
  scheduling_type: string | null;
  booking_fields: unknown;
  minimum_booking_notice: number;
  /** Booking window in calendar days ahead; NULL on every event without one. */
  booking_window_days: number | null;
  before_event_buffer: number;
  after_event_buffer: number;
  slot_interval: number | null;
  requires_confirmation: number;
  /** Duplicate-booking guard (#69); 0 on every event type nobody switched on. */
  prevent_duplicate_bookings: number;
  seats_per_time_slot: number | null;
  /** Tracking and pixels on the booking page (JSON); NULL on every event without them. */
  tracking: unknown;
}

export type BookingOutcome =
  | {
      ok: true;
      booking: BookingRecord;
      manageToken: string;
      deduplicated?: boolean;
      /**
       * A seat was added to an existing group booking (no manage token is
       * minted for it). Its calendar event already exists and now has one more
       * guest and a shared title and body (written with the seat, possibly
       * rendered again since): the caller rewrites it (`afterGuestsChanged`),
       * which a fresh booking never needs.
       */
      seatTaken?: true;
    }
  | {
      ok: false;
      reason:
        | 'SLOT_TAKEN'
        | 'NOT_FOUND'
        | 'RESERVATION_EXPIRED'
        | 'CALENDAR_UNAVAILABLE'
        /** The event type's duplicate-booking guard refused this email (#69).
         *  Carries NO slot detail, by design — see `duplicate-guard.ts`. */
        | 'DUPLICATE_BOOKING'
        /**
         * A one-off token was presented that names nothing, or that opens a
         * DIFFERENT event type than the one being booked (#110). Answers 404
         * upstream, indistinguishable from any other missing route — the two
         * cases are folded together on purpose, so the response cannot
         * confirm that a token exists somewhere else in the deployment.
         */
        | 'ONE_OFF_NOT_FOUND'
        /**
         * A one-off token that was real and is now dead — consumed by an
         * earlier booking, or revoked by the host. Answers 410; a cancel of
         * that earlier booking never brings it back. Kept apart from
         * `ONE_OFF_NOT_FOUND` because "this link was used" and "this link
         * never existed" are different things to tell a person.
         */
        | 'ONE_OFF_GONE';
    }
  | { ok: false; reason: 'INVALID'; message: string };

export interface BookingRecord {
  uid: string;
  status: string;
  title: string;
  /** The calendar event's body, when the event type's description template wrote one. */
  calendarDescription?: string | null;
  startMs: number;
  endMs: number;
  hostHandle: string | null;
  hostName: string | null;
  attendee: { name: string; email: string; timeZone: string };
}

export interface CreateBookingArgs {
  accountCode: string;
  /** Public lookup: the member's public handle. */
  handle?: string;
  /** Host lookup: resolve the member by id (host on-behalf bookings work even
   *  before the member sets a public handle). */
  memberId?: string;
  slug: string;
  startMs: number;
  attendee: {
    name: string;
    email: string;
    timeZone: string;
    notes?: string;
    phone?: string;
    /** Notification language (`en` | `es`). Persisted since H2 (#108); the
     *  contract has always accepted it and this layer used to drop it. */
    language?: string;
  };
  /** Additional creation-time guests/attendees, inserted in the booking transaction. */
  additionalAttendees?: Array<{
    name: string;
    email: string;
    timeZone: string;
    notes?: string;
    phone?: string;
    language?: string;
  }>;
  /** Answers to the event type's custom intake fields. */
  answers?: Record<string, unknown>;
  /**
   * The language the invitee booked in, stored as `booking.locale` (see
   * `bookingLocale`); the invitee's emails are written in it. Pass it only when
   * it is KNOWN: absent or unrecognised stores NULL, and NULL keeps the
   * invitee's mail in the host's language, as every booking before it.
   */
  locale?: string | null;
  /** Public API metadata. Internal keys are added by the repository. */
  metadata?: Record<string, unknown>;
  /** A held reservation to consume (deleted on success). */
  reservationUid?: string;
  /**
   * Refuse the time when another unexpired hold covers it, checked inside the
   * locked write (see `memberHeldSql`); the hold this booking consumes
   * (`reservationUid`) is its own and never counts. In-process callers only:
   * the MCP booking tools set it. Off, as on every REST route, a personal
   * booking does not look at holds, exactly as before.
   */
  refuseHeld?: boolean;
  idempotencyKey?: string;
  /** True when a host/agent booked on behalf (attribution; skips manage-token gating upstream). */
  onBehalf?: boolean;
  /**
   * True when this write arrives through an API key (the machine API or the
   * v2 compatibility surface). Only the duplicate-booking guard reads it
   * — it is a SEPARATE flag from `onBehalf` because the compatibility surface
   * is an API-key write that deliberately reports `onBehalf: false`. See
   * `duplicate-guard.ts`.
   */
  apiKeyWrite?: boolean;
  /**
   * A one-off link token presented with this write (#110), if any.
   *
   * Absent on every ordinary booking, which is why nothing about the existing
   * paths changes. When present and live it does two things and only two: it
   * lets the lookup see a HIDDEN event type, and it is burned once the booking
   * commits. It grants nothing else — it does not skip availability, the
   * duplicate guard, the overlap check or the reservation rules.
   *
   * Ignored entirely on host and API-key writes (`oneOffGuardApplies`), which
   * are not subject to the grant — see there for what exemption does and does
   * not mean.
   */
  oneOffToken?: string;
}

/**
 * The stored form of `booking.locale`: `en` or `es`, from a bare tag or a
 * regional one (`es-MX`), else null. Null is "not known", which keeps the
 * invitee's mail in the host's language, so anything this layer cannot read
 * degrades to exactly what every booking did before the column existed.
 */
export function bookingLocale(value: unknown): 'en' | 'es' | null {
  if (typeof value !== 'string') return null;
  const tag = value.trim().toLowerCase().split(/[-_]/)[0];
  return tag === 'en' || tag === 'es' ? tag : null;
}

/**
 * Names the booking page always collects as fixed attendee fields — kept in
 * sync with RESERVED_FIELD_NAMES in @slate/shared (db stays dependency-free
 * of shared). Legacy custom questions reusing them are no longer rendered by
 * the forms (QA3 fix 3), so requiring an answer here would 400 every booking
 * on such an event.
 */
const RESERVED_INTAKE_NAMES = new Set(['name', 'email', 'notes']);

/** Validate submitted intake answers against a set of field definitions. */
export function validateIntakeAnswers(
  fields: BookingFieldDef[],
  answers: Record<string, unknown> | undefined,
): string | null {
  for (const f of fields) {
    if (!f.required) continue;
    if (RESERVED_INTAKE_NAMES.has(f.name.trim().toLowerCase())) continue;
    const v = answers?.[f.name];
    const missing =
      v == null || v === '' || (Array.isArray(v) && v.length === 0) || v === false;
    if (missing) return `Missing required field: ${f.label}`;
  }
  return null;
}

// --- Resolvers ------------------------------------------------------------

/**
 * THE public-code resolver (one place, mission short-links §4): a URL segment
 * may be the canonical short code, a claimed vanity slug, or a retired legacy
 * code kept alive in account_alias — all resolve to the same account. Callers
 * that emit links must use `canonicalPublicCode(account)` (vanity ?? code);
 * the web layer 308-redirects non-canonical segments.
 */
export async function getAccountByCode(db: Db, code: string): Promise<AccountRow | undefined> {
  const c = code.toLowerCase();
  const cols = sql`id, code, name, vanity_slug`;
  const direct = await db.get<AccountRow>(
    sql`SELECT ${cols} FROM account WHERE code = ${c} OR vanity_slug = ${c} LIMIT 1`,
  );
  if (direct) return direct;
  return db.get<AccountRow>(
    sql`SELECT a.id, a.code, a.name, a.vanity_slug FROM account a
        JOIN account_alias al ON al.account_id = a.id
        WHERE al.alias = ${c} LIMIT 1`,
  );
}

export async function getMember(
  db: Db,
  accountId: string,
  handle: string,
): Promise<MemberRow | undefined> {
  return db.get<MemberRow>(
    sql`SELECT id, account_id, handle, display_name, email, avatar_url, cover_url, brand_color,
               layout, booking_page_style, time_zone, default_schedule_id
        FROM member WHERE account_id = ${accountId} AND handle = ${handle} LIMIT 1`,
  );
}

/**
 * `hidden = 0` is the PUBLIC filter, and the default stays public.
 *
 * `includeHidden` exists for exactly one caller: a request carrying a valid,
 * live one-off link (#110). Reaching an event the ordinary public URL cannot is
 * the entire value of such a link — a host mints one precisely so an event can
 * be hidden from their booking page and still bookable by the person they sent
 * it to. Every caller that does NOT pass it keeps today's behaviour exactly.
 *
 * The flag is never derived from anything caller-supplied. It is set only after
 * the token has been resolved against `one_off_link`, and the caller then
 * re-checks that the resolved link opens THIS event type — a token for event A
 * must not unlock event B.
 */
export async function getEventType(
  db: Db,
  accountId: string,
  memberId: string,
  slug: string,
  opts?: { includeHidden?: boolean },
): Promise<EventTypeRow | undefined> {
  const visibility = opts?.includeHidden ? sql`` : sql` AND hidden = 0`;
  return db.get<EventTypeRow>(
    sql`SELECT id, account_id, member_id, team_id, slug, title, description, length_minutes,
               locations, schedule_id, scheduling_type, booking_fields, minimum_booking_notice, booking_window_days,
               before_event_buffer, after_event_buffer, slot_interval, requires_confirmation,
               prevent_duplicate_bookings, seats_per_time_slot, tracking
        FROM event_type
        WHERE account_id = ${accountId} AND member_id = ${memberId} AND slug = ${slug}
              ${visibility} LIMIT 1`,
  );
}

export async function getMemberById(db: Db, id: string): Promise<MemberRow | undefined> {
  return db.get<MemberRow>(
    sql`SELECT id, account_id, handle, display_name, email, avatar_url, cover_url, brand_color,
               layout, booking_page_style, time_zone, default_schedule_id
        FROM member WHERE id = ${id} LIMIT 1`,
  );
}

export async function getEventTypeRowById(db: Db, id: string): Promise<EventTypeRow | undefined> {
  return db.get<EventTypeRow>(
    sql`SELECT id, account_id, member_id, team_id, slug, title, description, length_minutes,
               locations, schedule_id, scheduling_type, booking_fields, minimum_booking_notice, booking_window_days,
               before_event_buffer, after_event_buffer, slot_interval, requires_confirmation,
               prevent_duplicate_bookings, seats_per_time_slot, tracking
        FROM event_type WHERE id = ${id} LIMIT 1`,
  );
}

/**
 * B6: is `startMs` a REAL, currently-bookable slot for this host+event type?
 * Runs the SAME availability engine the booking flow uses — so it enforces the
 * schedule rules, min-notice, buffers, and "not in the past" — then checks the
 * instant is actually offered. Used to validate a reschedule target (the old
 * path only checked booking-overlap, letting a meeting move to 3 AM Sunday or
 * into the past). Resolves by member/event IDs so it works for personal AND
 * team bookings (a team event has no member handle). `excludeBookingId` drops
 * the booking being moved from the busy set so it can't block its own slot.
 */
export async function isSlotBookable(
  db: Db,
  args: {
    eventTypeId: string;
    hostMemberId: string;
    /**
     * This host's OWN schedule for the event (`event_type_host.schedule_id`),
     * for a TEAM event type whose hosts each bring their own hours. Pass it and
     * the resolution becomes `override ?? member default` — precisely what the
     * team availability projection does, so the picker and a reschedule cannot
     * read different hours for the same host. OMIT it (personal events, and
     * every caller that predates teams) and the event type's own `schedule_id`
     * leads, exactly as before. `null` is meaningful and NOT the same as
     * omitted: it says "this host has no override", i.e. use the member default.
     */
    hostScheduleId?: string | null;
    startMs: number;
    excludeBookingId?: string;
    now?: Date;
    calendar?: CalendarProvider;
  },
): Promise<boolean> {
  const eventType = await getEventTypeRowById(db, args.eventTypeId);
  const member = await getMemberById(db, args.hostMemberId);
  if (!eventType || !member) return false;

  const endMs = args.startMs + eventType.length_minutes * 60_000;
  const scheduleId = args.hostScheduleId !== undefined ? args.hostScheduleId : eventType.schedule_id;
  const schedule =
    (await resolveScheduleTimeZone(db, scheduleId)) ??
    (await resolveScheduleTimeZone(db, member.default_schedule_id));
  const scheduleTimeZone = schedule?.timeZone ?? member.time_zone;
  const rules: AvailabilityRule[] = schedule ? await loadAvailabilityRules(db, schedule.id) : [];

  // Host busy over the target window, minus the booking being rescheduled.
  // Through `loadBusyForHost` so this reads the SAME definition of busy the
  // availability projections do — a member is busy for a booking whether they
  // hold it as its organizer or as an assigned co-host. Its own query matched
  // `host_member_id` only, so a co-host's commitment was invisible here and
  // only the transactional overlap guard refused the move.
  const busyRows = await loadBusyForHost(
    db,
    args.hostMemberId,
    args.startMs,
    endMs,
    undefined,
    args.excludeBookingId,
  );
  // Fail-closed: an unreachable external calendar makes the target slot NOT
  // bookable (never move a meeting onto a conflict we couldn't see).
  let externalBusy: Interval[];
  try {
    externalBusy = await loadExternalBusy(db, args.calendar, args.hostMemberId, args.startMs, endMs, eventType.id);
  } catch {
    return false;
  }
  const busy: Interval[] = [
    ...busyRows,
    ...(await loadReservationBusy(db, args.hostMemberId, args.startMs, endMs, args.now?.getTime())),
    ...externalBusy,
  ];

  const slots = computeSlots({
    fromUtc: new Date(args.startMs),
    toUtc: new Date(endMs),
    timeZone: scheduleTimeZone,
    availability: rules,
    durationMin: eventType.length_minutes,
    slotIntervalMin: eventType.slot_interval,
    busy,
    beforeBufferMin: eventType.before_event_buffer,
    afterBufferMin: eventType.after_event_buffer,
    minimumBookingNoticeMin: eventType.minimum_booking_notice,
    bookingWindowDays: eventType.booking_window_days,
    now: args.now ?? new Date(),
  });
  return slots.some((d) => d.getTime() === args.startMs);
}

export interface PublicProfile {
  account: { code: string; name: string; shortCode: string };
  member: {
    handle: string;
    displayName: string | null;
    timeZone: string;
    /** What the host set in the studio. Their choice, and it always wins. */
    avatarUrl: string | null;
    /**
     * The photo on the connected calendar account, when the backend reports
     * one. A FALLBACK the public surfaces draw when `avatarUrl` is null — kept
     * as a separate field on purpose: folding it into `avatarUrl` would put a
     * synced URL into the studio's own input, where saving the form would turn
     * a fallback into a stored value that outlives the connection.
     */
    connectedAvatarUrl: string | null;
    coverUrl: string | null;
    brandColor: string | null;
    layout: string | null;
    style: Record<string, unknown> | null;
  };
  eventTypes: Array<{
    slug: string;
    title: string;
    description: string | null;
    lengthMinutes: number;
    location: ReturnType<typeof parseEventLocation>;
    timeZone: string;
    /** The event's tracking ids, loaded on its booking page; null = none. */
    tracking: EventTracking | null;
  }>;
}

export async function getPublicProfile(
  db: Db,
  accountCode: string,
  handle: string,
): Promise<PublicProfile | undefined> {
  const account = await getAccountByCode(db, accountCode);
  if (!account) return undefined;
  const member = await getMember(db, account.id, handle);
  if (!member || !member.handle) return undefined;
  // Each event's display zone resolves exactly the way `getAvailability` below
  // resolves it: the event's own schedule, else the host's default schedule,
  // (also when the event's own reference dangles), else the host. The event
  // page draws its month in this zone before it has
  // read a single slot, so the two must never disagree.
  const rows = await db.all<{
    slug: string;
    title: string;
    description: string | null;
    length_minutes: number;
    locations: unknown;
    schedule_time_zone: string | null;
    tracking: unknown;
  }>(
    sql`SELECT e.slug, e.title, e.description, e.length_minutes, e.locations, e.tracking,
               COALESCE(own.time_zone, dflt.time_zone) AS schedule_time_zone
        FROM event_type e
        LEFT JOIN schedule own ON own.id = e.schedule_id
        LEFT JOIN schedule dflt ON own.id IS NULL AND dflt.id = ${member.default_schedule_id ?? null}
        WHERE e.account_id = ${account.id} AND e.member_id = ${member.id} AND e.hidden = 0
        ORDER BY e.length_minutes ASC`,
  );
  // The destination connection first — that is the account the host actually
  // schedules from, so its photo is the one an invitee should recognise. Only
  // fetched when the host set no avatar of their own; their choice wins and
  // there is nothing to fall back to.
  // A host who removed that photo in the studio gets their monogram, and the
  // URL never leaves the server: the public response carries null.
  const style = parseJsonColumn<Record<string, unknown> | null>(member.booking_page_style, null);
  let connectedAvatar: string | null = null;
  if (!member.avatar_url && style?.hideConnectedPhoto !== true) {
    const avatars = await db.all<{ avatar_url: string | null }>(
      sql`SELECT avatar_url FROM connected_calendar
          WHERE account_id = ${account.id} AND member_id = ${member.id}
            AND avatar_url IS NOT NULL
          ORDER BY is_destination DESC, created_at ASC`,
    );
    connectedAvatar = avatars[0]?.avatar_url ?? null;
  }
  return {
    // Public responses always carry the CANONICAL code (vanity ?? short) so
    // clients build/redirect to canonical links even when queried by an alias.
    account: { code: canonicalPublicCode(account), name: account.name, shortCode: account.code },
    member: {
      handle: member.handle,
      displayName: member.display_name,
      timeZone: member.time_zone,
      avatarUrl: member.avatar_url,
      connectedAvatarUrl: connectedAvatar,
      coverUrl: member.cover_url,
      brandColor: member.brand_color,
      layout: member.layout,
      style,
    },
    eventTypes: rows.map((r) => ({
      slug: r.slug,
      title: r.title,
      description: r.description,
      lengthMinutes: r.length_minutes,
      location: parseEventLocation(parseJsonColumn<unknown>(r.locations, null)),
      timeZone: r.schedule_time_zone ?? member.time_zone,
      tracking: normalizeEventTracking(parseJsonColumn<unknown>(r.tracking, null)),
    })),
  };
}

// --- Availability ---------------------------------------------------------

export interface BookingFieldDef {
  name: string;
  label: string;
  type: string;
  required?: boolean;
  placeholder?: string;
  options?: string[];
}

export interface AvailabilityResult {
  eventType: {
    slug: string;
    title: string;
    lengthMinutes: number;
    bookingFields: BookingFieldDef[];
    /** Where the meeting happens — rendered on the public booking page. */
    location: EventLocation | null;
    /** Tracking and pixels on the booking page; set only by the invitee's read. */
    tracking?: EventTracking | null;
  };
  timeZone: string;
  /** Each offered instant. `spotsLeft`/`capacity` are set only for group events (R23). */
  slots: Array<{ startUtc: string; spotsLeft?: number; capacity?: number }>;
  /**
   * Present only when `slots` is empty because of a CONFIGURATION error
   * (missing schedule, no hours, unreachable external calendar) — never for
   * genuine fully-booked / out-of-range emptiness.
   */
  emptyReason?: AvailabilityEmptyReason;
}

export async function loadAvailabilityRules(db: Db, scheduleId: string): Promise<AvailabilityRule[]> {
  const rows = await db.all<{
    days: string | null;
    start_time: string;
    end_time: string;
    date: string | null;
  }>(
    sql`SELECT days, start_time, end_time, date FROM availability WHERE schedule_id = ${scheduleId}`,
  );
  return rows.map((r) => ({
    days: r.days ? (JSON.parse(r.days) as number[]) : null,
    startTime: r.start_time,
    endTime: r.end_time,
    date: r.date,
  }));
}

export async function loadBusyForHost(
  db: Db,
  hostMemberId: string,
  fromMs: number,
  toMs: number,
  /**
   * Group events (seats > 1): the event's OWN bookings must not blank out their
   * slot — the slot stays offered until seats fill (spotsLeft handles capacity).
   * Pass the event's id to exclude its bookings from the host busy set.
   */
  excludeEventTypeId?: string,
  /**
   * The booking being MOVED. A reschedule must not let a booking's current
   * instant — or the buffers around it — block its own move, so both the write
   * and the reschedule picker drop it from the host's busy set.
   */
  excludeBookingId?: string,
): Promise<Interval[]> {
  const exclude = excludeEventTypeId ? sql` AND b.event_type_id <> ${excludeEventTypeId}` : sql``;
  const excludeBooking = excludeBookingId ? sql` AND b.id <> ${excludeBookingId}` : sql``;
  // A member is busy for a booking whether they're the primary host_member_id OR
  // an assigned co-host (collective / fixed_round_robin) recorded in booking_host.
  const rows = await db.all<{ start_ms: number; end_ms: number }>(
    sql`SELECT b.start_ms, b.end_ms FROM booking b
        WHERE b.status IN ('accepted','pending')
              AND b.start_ms < ${toMs} AND b.end_ms > ${fromMs}${exclude}${excludeBooking}
              AND (b.host_member_id = ${hostMemberId}
                   OR EXISTS (SELECT 1 FROM booking_host bh
                              WHERE bh.booking_id = b.id AND bh.member_id = ${hostMemberId}))`,
  );
  return rows.map((r) => ({ start: new Date(Number(r.start_ms)), end: new Date(Number(r.end_ms)) }));
}

/** Active (unexpired) slot holds for a host — subtracted from availability. */
export async function loadReservationBusy(
  db: Db,
  memberId: string,
  fromMs: number,
  toMs: number,
  now = Date.now(),
): Promise<Interval[]> {
  const rows = await db.all<{ slot_start_ms: number; slot_end_ms: number }>(
    sql`SELECT slot_start_ms, slot_end_ms FROM slot_reservation
        WHERE member_id = ${memberId} AND release_at_ms > ${now}
              AND slot_start_ms < ${toMs} AND slot_end_ms > ${fromMs}`,
  );
  return rows.map((r) => ({
    start: new Date(Number(r.slot_start_ms)),
    end: new Date(Number(r.slot_end_ms)),
  }));
}

export async function resolveScheduleTimeZone(
  db: Db,
  scheduleId: string | null,
): Promise<{ id: string; timeZone: string } | undefined> {
  if (!scheduleId) return undefined;
  return db.get<{ id: string; timeZone: string }>(
    sql`SELECT id, time_zone AS "timeZone" FROM schedule WHERE id = ${scheduleId} LIMIT 1`,
  );
}

/**
 * The span busy time must be read over for slots that START in
 * [fromMs, toMs).
 *
 * A slot is offered by its start, but it is tested against busy time for its
 * whole length plus both buffers, so a slot starting just before `toMs` runs
 * past it and one starting at `fromMs` reaches back before it. Read over the
 * bare window and an event sitting right past either edge is never seen: the
 * slot is offered free and the create-time check, which reads only that slot,
 * then refuses it. That used to matter only at the 60-day horizon; the booking
 * page now reads a month at a time, so every month edge is a window edge.
 */
export function busyReadSpan(
  fromMs: number,
  toMs: number,
  eventType: { length_minutes: number; before_event_buffer?: number | null; after_event_buffer?: number | null },
): { fromMs: number; toMs: number } {
  const before = (eventType.before_event_buffer ?? 0) * 60_000;
  const after = (eventType.length_minutes + (eventType.after_event_buffer ?? 0)) * 60_000;
  return { fromMs: fromMs - before, toMs: toMs + after };
}

export async function getAvailability(
  db: Db,
  args: {
    accountCode: string;
    /** Public lookup: the member's public handle. */
    handle?: string;
    /** Host lookup: resolve the member by id — works for members with no handle
     *  yet (the authenticated host booking their own manual slots). */
    memberId?: string;
    slug: string;
    fromMs: number;
    toMs: number;
    displayTimeZone?: string;
    now?: Date;
    /**
     * Let a HIDDEN event type answer (#110). Set only by a caller that has
     * already resolved a live one-off link over this exact event type — the
     * booking page a one-off link opens has to be able to read slots for the
     * hidden event the link exists to reach. Never derived from the request.
     */
    includeHidden?: boolean;
  },
  /**
   * The wired CalendarProvider. When enabled, the host's external busy times are
   * subtracted from the offered slots. Undefined / disabled ⇒ local busy only
   * (the OSS clone-and-run default — no behavior change).
   */
  calendar?: CalendarProvider,
): Promise<AvailabilityResult | undefined> {
  const account = await getAccountByCode(db, args.accountCode);
  if (!account) return undefined;
  const member = args.memberId
    ? await getMemberById(db, args.memberId)
    : args.handle
      ? await getMember(db, account.id, args.handle)
      : undefined;
  // The by-id path must stay account-scoped (tenant isolation).
  if (!member || member.account_id !== account.id) return undefined;
  const eventType = await getEventType(db, account.id, member.id, args.slug, {
    includeHidden: args.includeHidden,
  });
  if (!eventType) return undefined;

  const referenced = await resolveScheduleTimeZone(db, eventType.schedule_id);
  const fallback = referenced
    ? undefined
    : await resolveScheduleTimeZone(db, member.default_schedule_id);
  const schedule = referenced ?? fallback;
  const scheduleTimeZone = schedule?.timeZone ?? member.time_zone;

  let rules: AvailabilityRule[] = [];
  if (schedule) rules = await loadAvailabilityRules(db, schedule.id);

  const eventTypeOut = {
    slug: eventType.slug,
    title: eventType.title,
    lengthMinutes: eventType.length_minutes,
    bookingFields: parseJsonColumn<BookingFieldDef[]>(eventType.booking_fields, []),
    location: parseEventLocation(parseJsonColumn<unknown>(eventType.locations, null)),
    tracking: normalizeEventTracking(parseJsonColumn<unknown>(eventType.tracking, null)),
  };
  const displayTz = args.displayTimeZone ?? scheduleTimeZone;

  // Config errors (dangling schedule ref / no schedule / no hours) must be
  // RECOGNIZABLE, not a silent empty array — classify before computing.
  const configReason = classifyEmptyReason({
    referencedScheduleId: eventType.schedule_id,
    referencedScheduleExists: !!referenced,
    fallbackScheduleExists: !!fallback,
    ruleCount: rules.length,
  });
  if (configReason) {
    return { eventType: eventTypeOut, timeZone: displayTz, slots: [], emptyReason: configReason };
  }

  const capacity = eventType.seats_per_time_slot ?? 1;
  const isGroup = capacity > 1;

  // External busy is FAIL-CLOSED: if the connected calendar can't be read we
  // withhold slots (with a visible reason) rather than offer times that may
  // double-book — and rather than 500 on the whole request.
  const read = busyReadSpan(args.fromMs, args.toMs, eventType);
  let externalBusy: Interval[];
  try {
    externalBusy = await loadExternalBusy(db, calendar, member.id, read.fromMs, read.toMs, eventType.id);
  } catch {
    return {
      eventType: eventTypeOut,
      timeZone: displayTz,
      slots: [],
      emptyReason: 'CALENDAR_UNAVAILABLE',
    };
  }

  const busy = [
    // Group events don't self-block: their own bookings stay offered until full.
    ...(await loadBusyForHost(db, member.id, read.fromMs, read.toMs, isGroup ? eventType.id : undefined)),
    ...(await loadReservationBusy(db, member.id, read.fromMs, read.toMs, args.now?.getTime())),
    ...externalBusy,
  ];

  const slots = computeSlots({
    fromUtc: new Date(args.fromMs),
    toUtc: new Date(args.toMs),
    timeZone: scheduleTimeZone,
    availability: rules,
    durationMin: eventType.length_minutes,
    slotIntervalMin: eventType.slot_interval,
    busy,
    beforeBufferMin: eventType.before_event_buffer,
    afterBufferMin: eventType.after_event_buffer,
    minimumBookingNoticeMin: eventType.minimum_booking_notice,
    bookingWindowDays: eventType.booking_window_days,
    now: args.now ?? new Date(),
  });

  // Group events (R23): annotate each slot with seats left and drop full ones.
  let outSlots: Array<{ startUtc: string; spotsLeft?: number; capacity?: number }>;
  if (isGroup) {
    const taken = await seatsTakenByStart(db, eventType.id, args.fromMs, args.toMs);
    outSlots = slots
      .map((d) => {
        const ms = d.getTime();
        const spotsLeft = capacity - (taken.get(ms) ?? 0);
        return { startUtc: d.toISOString(), spotsLeft, capacity };
      })
      .filter((s) => (s.spotsLeft ?? 0) > 0);
  } else {
    outSlots = slots.map((d) => ({ startUtc: d.toISOString() }));
  }

  return { eventType: eventTypeOut, timeZone: displayTz, slots: outSlots };
}

/**
 * Seats consumed per start instant for a group event = the people on its
 * accepted/pending bookings there (one booking row per slot), counted the way
 * the seat write counts them (`peopleOn`): attendees, guests added to the
 * booking and the guests it names, each address once.
 */
async function seatsTakenByStart(
  db: Db,
  eventTypeId: string,
  fromMs: number,
  toMs: number,
): Promise<Map<number, number>> {
  const inWindow = sql`b.event_type_id = ${eventTypeId} AND b.status IN ('accepted','pending')
        AND b.start_ms >= ${fromMs} AND b.start_ms < ${toMs}`;
  const bookings = await db.all<{ id: string; start_ms: number; metadata: unknown }>(
    sql`SELECT b.id, b.start_ms, b.metadata FROM booking b WHERE ${inWindow}`,
  );
  if (bookings.length === 0) return new Map();
  const rows = peopleRowsByBooking(
    await db.all<{ booking_id: string; email: string | null }>(peopleRowsSql(inWindow)),
  );
  const people = new Map<number, Set<string>>();
  for (const b of bookings) {
    const start = Number(b.start_ms);
    const onBooking = peopleOn(rows.get(b.id) ?? [], b.metadata);
    people.set(start, new Set([...(people.get(start) ?? []), ...onBooking]));
  }
  return new Map([...people].map(([start, set]) => [start, set.size]));
}

// --- Create booking (the atomic, dual-enforced write) ---------------------

/**
 * A live booking of this host over [startMs, endMs), held as its organizer OR
 * as an assigned co-host (`booking_host`). The co-host half matters because
 * the Postgres EXCLUDE covers `host_member_id` only: a host's seat on a team
 * booking is invisible to it, so this check is the only guard for it.
 */
function hostOverlapSql(hostMemberId: string, startMs: number, endMs: number) {
  return sql`SELECT b.id FROM booking b
      WHERE b.status IN ('accepted','pending')
        AND b.start_ms < ${endMs} AND b.end_ms > ${startMs}
        AND (b.host_member_id = ${hostMemberId}
             OR EXISTS (SELECT 1 FROM booking_host bh WHERE bh.booking_id = b.id AND bh.member_id = ${hostMemberId}))
      LIMIT 1`;
}

/**
 * Lock these members' rows, in id order (one order everywhere, so two writers
 * can never each hold one the other waits for). A no-op for an empty list.
 */
export async function lockMembers(
  tx: { execute: (query: ReturnType<typeof sql>) => Promise<unknown> },
  memberIds: string[],
): Promise<void> {
  const ids = [...new Set(memberIds.filter(Boolean))].sort();
  if (ids.length === 0) return;
  await tx.execute(
    sql`SELECT id FROM member WHERE id IN (${sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    )}) ORDER BY id FOR UPDATE`,
  );
}

/**
 * True (as a 1-row SELECT) if `memberId` has an unexpired soft hold overlapping
 * the time, other than `exceptUid` (the hold a booking consumes): the overlap
 * `loadReservationBusy` subtracts from availability. The guarded writes run it
 * after the member's row lock (Postgres) or inside their IMMEDIATE transaction
 * (SQLite), where the hold write (`insertHoldGuarded`) runs too, so a hold and
 * a booking over one host can never both pass their checks.
 *
 * @internal Shared by the guarded writes; not a query for callers.
 */
export function memberHeldSql(memberId: string, startMs: number, endMs: number, now: number, exceptUid?: string) {
  const except = exceptUid ? sql` AND uid <> ${exceptUid}` : sql``;
  return sql`SELECT 1 AS hit FROM slot_reservation
      WHERE member_id = ${memberId} AND release_at_ms > ${now}
        AND slot_start_ms < ${endMs} AND slot_end_ms > ${startMs}${except} LIMIT 1`;
}

function overlapExists(db: Db, hostMemberId: string, startMs: number, endMs: number): boolean {
  // SQLite synchronous read via the native drizzle instance (inside a txn).
  return !!db.sqlite!.drizzle.get<{ id: string }>(hostOverlapSql(hostMemberId, startMs, endMs));
}


/**
 * Sanity range for any booking start instant (QA fix 8): the server stored a
 * 1905 booking that arrived through the host "Any time" form. Small grace for
 * clock skew / in-flight slots; 2 years matches the furthest any scheduling
 * UI here can navigate.
 */
export const BOOKING_PAST_GRACE_MS = 5 * 60_000;
export const BOOKING_MAX_FUTURE_MS = 2 * 366 * 86_400_000;
export function bookingStartOutOfRange(startMs: number, now = Date.now()): string | null {
  if (!Number.isFinite(startMs)) return 'Invalid start time.';
  if (startMs < now - BOOKING_PAST_GRACE_MS) return 'Start time is in the past.';
  if (startMs > now + BOOKING_MAX_FUTURE_MS) return 'Start time is too far in the future (max 2 years).';
  return null;
}

/**
 * The value actually stored in `booking.idempotency_key` (#104).
 *
 * That column carries a GLOBAL `UNIQUE`, so a raw caller-supplied key belongs
 * to whichever tenant writes it first: a second account reusing the same
 * string collides on insert and can never book with it, and a replay lookup
 * that forgot its account would hand one tenant's booking to another. Both
 * halves are closed by never storing the raw key — the account id is folded in
 * here, and every read of the column goes through the same function so the
 * write and the lookup cannot drift apart.
 *
 * The prefix needs no escaping, but the reason is narrower than it looks. Keys
 * are opaque, so within one account the mapping is trivially injective; what
 * the UNIQUE column needs is injectivity ACROSS accounts, and that holds only
 * because an account id never contains the separator. Ids are `randomUUID()`
 * (see `insertAccountWithShortCode` in `short-links.ts`), so it never does.
 * Were that to change, `a:b` + `c` and `a` + `b:c` would collide.
 *
 * Callers still hold the raw key (it is what the client retries with); only
 * storage and lookup are namespaced.
 */
export function scopedIdempotencyKey(accountId: string, key: string): string {
  return `${accountId}:${key}`;
}

export async function createBooking(
  db: Db,
  args: CreateBookingArgs,
  /**
   * Wired CalendarProvider: the create path re-checks the host's external busy
   * over the booking window (fail-closed). Undefined/disabled ⇒ local-only,
   * exactly the pre-existing clone-and-run behavior.
   */
  calendar?: CalendarProvider,
): Promise<BookingOutcome> {
  const account = await getAccountByCode(db, args.accountCode);
  if (!account) return { ok: false, reason: 'NOT_FOUND' };
  const member = args.memberId
    ? await getMemberById(db, args.memberId)
    : args.handle
      ? await getMember(db, account.id, args.handle)
      : undefined;
  // The by-id path must stay account-scoped (tenant isolation).
  if (!member || member.account_id !== account.id) return { ok: false, reason: 'NOT_FOUND' };

  // One-off link (#69/AB2): resolved BEFORE the event type, because a live link
  // is what decides whether a HIDDEN event type is visible to this request at
  // all. Exempt writes (host on-behalf, API key) skip the whole block — a token
  // they happen to carry is neither validated nor burned, and their visibility
  // is unchanged from today. See `one-off-link.ts`.
  //
  // ABOVE the idempotency replay below, which is the opposite of where the
  // duplicate-booking guard sits, and deliberately so. That guard is a verdict
  // about PRIOR STATE ("this email already has a booking"), and a retry must
  // return its original booking rather than be told about it. A one-off token
  // is a CREDENTIAL FOR THIS WRITE, and a request presenting a spent credential
  // is refused on its own terms whether or not some earlier request succeeded.
  // The ordering is also forced: `getEventType` sits above the replay and the
  // token is what makes a hidden one visible, so a dead token cannot resolve
  // the event type this write needs before the replay is ever reached. No caller reaches both today — the
  // public route sends no idempotency key, and every surface that does is
  // `apiKeyWrite` and therefore exempt — but the reasoning is written down
  // because the next person to plumb a key through the public route will
  // otherwise have to re-derive it.
  const honoursOneOff =
    !!args.oneOffToken &&
    oneOffGuardApplies({ onBehalf: args.onBehalf, apiKeyWrite: args.apiKeyWrite });
  // Shape first, as the read paths do: the value is an unauthenticated header,
  // and a malformed one is answered without spending a lookup on it.
  if (honoursOneOff && !isOneOffTokenShape(args.oneOffToken))
    return { ok: false, reason: 'ONE_OFF_NOT_FOUND' };
  let live: OneOffLinkRecord | undefined;
  if (honoursOneOff) {
    const oneOff = await getOneOffLinkByToken(db, args.oneOffToken!);
    if (!oneOff) return { ok: false, reason: 'ONE_OFF_NOT_FOUND' };
    if (oneOff.state !== 'live') return { ok: false, reason: 'ONE_OFF_GONE' };
    live = oneOff;
  }

  const eventType = await getEventType(db, account.id, member.id, args.slug, {
    includeHidden: !!live,
  });
  if (!eventType) return { ok: false, reason: 'NOT_FOUND' };
  // The link must open THIS event, not merely be live. Without this a token
  // minted over a public 15-minute intro would unlock every hidden event on the
  // account. Both halves are checked: the account, because the link is looked
  // up by token alone and carries its own tenant, and the event type.
  if (live && (live.eventTypeId !== eventType.id || live.accountId !== account.id))
    return { ok: false, reason: 'ONE_OFF_NOT_FOUND' };

  // Start-instant sanity (QA fix 8) — applies to every surface, including the
  // host "Any time (outside availability)" path that let a 1905 date through.
  const rangeErr = bookingStartOutOfRange(args.startMs);
  if (rangeErr) return { ok: false, reason: 'INVALID', message: rangeErr };

  // Required-intake validation (server-side; never trust the client).
  const fields = parseJsonColumn<BookingFieldDef[]>(eventType.booking_fields, []);
  const invalid = validateIntakeAnswers(fields, args.answers);
  if (invalid) return { ok: false, reason: 'INVALID', message: invalid };
  const unnamed = attendeeWithoutAddress(args.attendee, args.additionalAttendees);
  if (unnamed) return { ok: false, reason: 'INVALID', message: unnamed };

  // QA fix 13: a PUBLIC booking that isn't consuming a hold must land on a
  // genuinely offered slot — before this, an unauthenticated caller could
  // skip the reservation step and book a host at 3 AM Sunday. The check uses
  // the same seat-aware availability engine the booking page renders from
  // (group events keep filling seats on a shared slot), WITHOUT the external
  // calendar: the fail-closed busy/unreachable handling stays downstream so
  // its CALENDAR_UNAVAILABLE / SLOT_TAKEN semantics are unchanged. On-behalf
  // host/agent bookings intentionally may book outside availability — the
  // "Any time" feature.
  if (!args.onBehalf && !args.reservationUid) {
    // Rules-only projection (busy deliberately empty): whether the host's
    // configuration OFFERS this instant at all — working hours, slot
    // interval, min-notice. Busy/seat/full handling stays downstream so its
    // SLOT_TAKEN / group-seat semantics are untouched.
    const referenced = await resolveScheduleTimeZone(db, eventType.schedule_id);
    const fallback = referenced
      ? undefined
      : await resolveScheduleTimeZone(db, member.default_schedule_id);
    const schedule = referenced ?? fallback;
    const rules = schedule ? await loadAvailabilityRules(db, schedule.id) : [];
    const offered =
      rules.length > 0 &&
      computeSlots({
        fromUtc: new Date(args.startMs),
        toUtc: new Date(args.startMs + eventType.length_minutes * 60_000),
        timeZone: schedule?.timeZone ?? member.time_zone,
        availability: rules,
        durationMin: eventType.length_minutes,
        slotIntervalMin: eventType.slot_interval,
        busy: [],
        beforeBufferMin: eventType.before_event_buffer,
        afterBufferMin: eventType.after_event_buffer,
        minimumBookingNoticeMin: eventType.minimum_booking_notice,
        bookingWindowDays: eventType.booking_window_days,
        now: new Date(),
      }).some((d) => d.getTime() === args.startMs);
    if (!offered) return { ok: false, reason: 'INVALID', message: 'That time is not available.' };
  }

  // Idempotency: return the prior booking for a repeated key. Scoped to the
  // account resolved above (#104) — a key only ever replays its own tenant's
  // booking.
  if (args.idempotencyKey) {
    const prior = await findBookingByIdempotencyKey(db, account.id, args.idempotencyKey);
    // Replay: return the existing booking, do NOT re-mint the token, and flag it
    // deduplicated (B3 — contract).
    if (prior) return { ok: true, booking: prior.record, manageToken: '', deduplicated: true };
  }

  // Hold validation at consume: a reservation that is missing or expired → 410.
  // (The two-layer expiry: app-level release_at check here + the DB sweep.)
  //
  // The hold must be for THIS host, event and time. A booking that presents a
  // hold skips the offered-slot check above (the hold was granted on an offered
  // time), so a hold matched by uid alone let any live hold book any time on
  // any event, hours and notice ignored. One for another time answers the same
  // 410 as a missing one: the booker picks a time again.
  if (args.reservationUid) {
    const hold = await db.get<{ release_at_ms: number }>(
      sql`SELECT release_at_ms FROM slot_reservation
          WHERE uid = ${args.reservationUid} AND member_id = ${member.id}
                AND event_type_id = ${eventType.id} AND slot_start_ms = ${args.startMs}
          LIMIT 1`,
    );
    if (!hold) return { ok: false, reason: 'RESERVATION_EXPIRED' };
    if (Number(hold.release_at_ms) <= Date.now()) {
      await db.run(sql`DELETE FROM slot_reservation WHERE uid = ${args.reservationUid}`);
      return { ok: false, reason: 'RESERVATION_EXPIRED' };
    }
  }

  // Duplicate-booking guard (#69/AB1): the host switched this event type to one
  // upcoming booking per email. Placed AFTER the idempotency replay above — a
  // repeated key must return its original booking, never a 409 — and BEFORE the
  // group-seat branch below, so on a multi-seat event the same address is
  // refused instead of quietly taking a second seat. Advisory and outside the
  // write transaction on purpose; see `duplicate-guard.ts`.
  if (
    duplicateGuardApplies({
      preventDuplicateBookings: eventType.prevent_duplicate_bookings,
      onBehalf: args.onBehalf,
      apiKeyWrite: args.apiKeyWrite,
    }) &&
    (await hasUpcomingBookingForEmail(db, account.id, eventType.id, args.attendee.email))
  ) {
    return { ok: false, reason: 'DUPLICATE_BOOKING' };
  }

  const startMs = args.startMs;
  const endMs = startMs + eventType.length_minutes * 60_000;

  // One attendee row per address (see `distinctAttendees`), so a seat is never
  // taken (or counted) twice for one person, on the first booking of a slot or
  // a later one.
  const requested = distinctAttendees(args.attendee, args.additionalAttendees);
  const additionalAttendees = requested.slice(1);

  // R23 group events (seats > 1): a slot is ONE booking row that accrues up to
  // `capacity` attendees. A second+ booker adds a seat to the existing row
  // (so it never trips the one-accepted-per-slot overlap/EXCLUDE guard); the
  // FIRST booker falls through to the normal create below.
  const capacity = eventType.seats_per_time_slot ?? 1;
  if (capacity > 1) {
    const existing = await db.get<{
      id: string;
      uid: string;
      status: string;
      start_ms: number;
      end_ms: number;
      metadata: unknown;
    }>(
      sql`SELECT id, uid, status, start_ms, end_ms, metadata FROM booking
          WHERE event_type_id = ${eventType.id} AND host_member_id = ${member.id}
                AND start_ms = ${startMs} AND status IN ('accepted','pending') LIMIT 1`,
    );
    if (existing) {
      // A request whose every address already holds a seat (a retried
      // request, or the same people again) is answered as a replay: nothing is
      // inserted twice, no seat is spent twice and the calendar event is not
      // rewritten again. It carries the event's name only, never the slot's
      // stored text, which an address alone must not be enough to read. One new
      // address is enough to take seats: the ones already held are left out.
      // Checked here and again under the lock below, where a concurrent
      // repeat would otherwise slip in.
      // Everyone on the slot holds a seat, each person once: its seat-takers,
      // and guests added to it count too, or a slot could hold more people
      // than it seats (`peopleOn`, as availability and holds count them).
      const takenSql = peopleRowsSql(sql`b.id = ${existing.id}`);
      const replay = (): BookingOutcome => ({
        ok: true,
        booking: {
          uid: existing.uid,
          status: existing.status,
          title: plainCalendarTitle(eventType.title),
          calendarDescription: null,
          startMs: Number(existing.start_ms),
          endMs: Number(existing.end_ms),
          hostHandle: member.handle,
          hostName: member.display_name,
          attendee: { name: args.attendee.name, email: args.attendee.email, timeZone: args.attendee.timeZone },
        },
        manageToken: '',
        deduplicated: true,
      });
      const allHeld = (held: ReadonlySet<string>) =>
        requested.every((attendee) => held.has(normalizeAttendeeEmail(attendee.email)));
      if (allHeld(peopleOn(await db.all<{ email: string | null }>(takenSql), existing.metadata))) return replay();
      // Seats, holds and the booking itself are read again under the host's
      // lock (the one every guarded booking write and the hold write take),
      // then the booking's own row (member first, booking second, the order a
      // confirmation takes them in). Everything read above is a snapshot: a
      // concurrent seat, a hold landing after the caller's own checks, or a
      // cancel or move of this booking (those do not take the member lock)
      // must not slip in between the read and the insert.
      const seatTime = Date.now();
      // One seat per address: the request's attendees (`requested`, each
      // address once) less those that already hold a seat on the slot. Only
      // those are inserted and counted against the seats left.
      const seatInserts = (held: ReadonlySet<string>) => {
        return requested
          .filter((attendee) => !held.has(normalizeAttendeeEmail(attendee.email)))
          .map(
            (attendee, i) => sql`INSERT INTO booking_attendee (id, booking_id, name, email, email_normalized, time_zone, phone, notes, language, created_at)
            VALUES (${randomUUID()}, ${existing.id}, ${attendee.name}, ${attendee.email},
              ${normalizeAttendeeEmail(attendee.email)},
              ${attendee.timeZone}, ${attendee.phone ?? null}, ${attendee.notes ?? null},
              ${attendee.language ?? null}, ${seatTime + i})`,
          );
      };
      // The slot is now shared by people who booked separately: its calendar
      // title and description must never carry one of them, whatever the
      // event type's seats become. Marked with the seat, in one transaction.
      const markShared = markSharedSql(existing.id, eventType.title);
      const heldElsewhere = args.refuseHeld
        ? memberHeldSql(member.id, startMs, endMs, seatTime, args.reservationUid)
        : null;
      const stillThere = (row: { status: string; start_ms: number | string } | undefined) =>
        !!row && (row.status === 'accepted' || row.status === 'pending') && Number(row.start_ms) === startMs;
      // The booking's status as it stands under the lock; 'repeat' when every
      // address took its seat meanwhile; null when no seat was taken.
      type SeatResult = { status: string } | 'repeat' | null;
      let seated: SeatResult;
      if (db.dialect === 'sqlite') {
        seated = db.sqlite!.txn<SeatResult>(() => {
          const now = db.sqlite!.drizzle.get<{ status: string; start_ms: number; metadata: unknown }>(
            sql`SELECT status, start_ms, metadata FROM booking WHERE id = ${existing.id} LIMIT 1`,
          );
          if (!stillThere(now)) return null;
          const held = peopleOn(db.sqlite!.drizzle.all<{ email: string | null }>(takenSql), now!.metadata);
          const inserts = seatInserts(held);
          if (inserts.length === 0) return 'repeat';
          // Every seat this request takes must fit, not only the first.
          if (held.size + inserts.length > capacity) return null;
          if (heldElsewhere && db.sqlite!.drizzle.get(heldElsewhere)) return null;
          for (const insert of inserts) db.sqlite!.drizzle.run(insert);
          db.sqlite!.drizzle.run(markShared);
          return { status: now!.status };
        }, { immediate: true });
      } else {
        seated = await db.pg!.drizzle.transaction(async (tx): Promise<SeatResult> => {
          await tx.execute(sql`SELECT id FROM member WHERE id = ${member.id} FOR UPDATE`);
          const now = (await tx.execute(
            sql`SELECT status, start_ms, metadata FROM booking WHERE id = ${existing.id} FOR UPDATE`,
          )) as unknown as Array<{ status: string; start_ms: number | string; metadata: unknown }>;
          if (!stillThere(now[0])) return null;
          const held = peopleOn(
            (await tx.execute(takenSql)) as unknown as Array<{ email: string | null }>,
            now[0]!.metadata,
          );
          const inserts = seatInserts(held);
          if (inserts.length === 0) return 'repeat';
          // Every seat this request takes must fit, not only the first.
          if (held.size + inserts.length > capacity) return null;
          if (heldElsewhere && ((await tx.execute(heldElsewhere)) as unknown as unknown[]).length > 0) return null;
          for (const insert of inserts) await tx.execute(insert);
          await tx.execute(markShared);
          return { status: now[0]!.status };
        });
      }
      if (seated === 'repeat') return replay();
      if (!seated) return { ok: false, reason: 'SLOT_TAKEN' };
      // Rendered again as shared now, since the stored text may be the first
      // booker's own from before the seats; reset to the event's name when
      // that render did not land.
      const shared =
        (await applyCalendarTemplates(db, existing.uid)) ??
        (await applySharedFallback(db, { id: existing.id, startMs, endMs: Number(existing.end_ms) }, eventType.title));
      if (args.reservationUid)
        await db.run(sql`DELETE FROM slot_reservation WHERE uid = ${args.reservationUid}`);
      // Times and status as checked under the lock, never the earlier snapshot.
      const rec: BookingRecord = {
        uid: existing.uid,
        status: seated.status,
        // The slot's one calendar event, as just rendered for everyone on it
        // (or reset to the event's name); never the stored text, which may
        // name the first booker.
        title: shared?.title ?? plainCalendarTitle(eventType.title),
        calendarDescription: shared?.description || null,
        startMs,
        endMs: Number(existing.end_ms),
        hostHandle: member.handle,
        hostName: member.display_name,
        attendee: { name: args.attendee.name, email: args.attendee.email, timeZone: args.attendee.timeZone },
      };
      // Burn the one-off link (#110). A seat on a group event is a booking like
      // any other, so a link spent on one is spent — the alternative would let
      // a single link fill every seat, which is the opposite of what it is for.
      if (live) await consumeOneOffLink(db, live.id, existing.id);
      // Seat-takers join the shared group booking; the manage link stays with
      // the first booker (per-seat manage tokens are a follow-up). The event
      // is rewritten for them even when the render above did not land: the
      // seat wrote the shared text with it (`markSharedSql`).
      return { ok: true, booking: rec, manageToken: '', seatTaken: true };
    }
  }

  // The first booking of a group slot takes a seat per attendee too: a request
  // for more seats than the time has is refused, as a seat request is above.
  if (capacity > 1 && requested.length > capacity)
    return { ok: false, reason: 'INVALID', message: `This time has ${capacity} seats; the booking asks for ${requested.length}.` };

  // External-calendar conflict check at CREATE time (error-visibility §5).
  // Availability reads already subtract external busy, but the create path
  // previously trusted the read blindly — a slot gone busy on the connected
  // calendar between read and book was silently double-booked. Policy:
  // fail-closed — a conflict rejects the slot, and an UNREADABLE calendar
  // blocks the booking visibly instead of booking blind.
  try {
    const externalBusy = await loadExternalBusy(db, calendar, member.id, startMs, endMs, eventType.id);
    if (externalBusy.some((b) => b.start.getTime() < endMs && b.end.getTime() > startMs)) {
      return { ok: false, reason: 'SLOT_TAKEN' };
    }
  } catch {
    return { ok: false, reason: 'CALENDAR_UNAVAILABLE' };
  }

  const now = Date.now();
  const uid = randomUUID();
  const bookingId = randomUUID();
  const attendeeId = randomUUID();
  const { token, tokenHash } = generateManageToken();
  const metadata = JSON.stringify({ ...(args.metadata ?? {}), _manage: { tokenHash } });
  const title = eventType.title;

  // Postgres stores metadata as jsonb (source-of-truth, full power); the bound
  // text param is cast on write. SQLite stores the same JSON as text.
  // requiresConfirmation → the booking starts 'pending' (host confirms later);
  // otherwise 'accepted'. Pending still HOLDS the slot (overlap check includes it).
  const status = eventType.requires_confirmation ? 'pending' : 'accepted';
  const metaExpr = db.dialect === 'postgres' ? sql`${metadata}::jsonb` : sql`${metadata}`;
  const responsesExpr = jsonParam(db, args.answers ?? null);
  // Snapshot the event type's configured Where onto the booking so the manage
  // page (and calendar write-out) can show it, even if the event is edited later.
  // The KIND drives behaviour (conferencing ⇒ request a link at write-out); the
  // detail is the human string. Both are frozen here on purpose.
  const eventLocation = parseEventLocation(parseJsonColumn<unknown>(eventType.locations, null));
  // Other attendees on the booking are guests on its one calendar event, so it
  // is shared from the start: its title and description never carry the
  // invitee's own data (see `applyCalendarTemplates`).
  const insertBooking = sql`
    INSERT INTO booking (id, account_id, uid, event_type_id, host_member_id, title, location, location_kind,
      start_ms, end_ms, status, metadata, responses, attendee_time_zone, locale, idempotency_key,
      seated, created_at, updated_at)
    VALUES (${bookingId}, ${account.id}, ${uid}, ${eventType.id}, ${member.id}, ${title},
      ${eventLocation?.detail ?? null}, ${eventLocation?.kind ?? null},
      ${startMs}, ${endMs}, ${status}, ${metaExpr}, ${responsesExpr}, ${args.attendee.timeZone},
      ${bookingLocale(args.locale)},
      ${args.idempotencyKey ? scopedIdempotencyKey(account.id, args.idempotencyKey) : null},
      ${additionalAttendees.length > 0 ? 1 : null}, ${now}, ${now})`;
  const insertAttendee = sql`
    INSERT INTO booking_attendee (id, booking_id, name, email, email_normalized, time_zone, phone, notes, language, created_at)
    VALUES (${attendeeId}, ${bookingId}, ${args.attendee.name}, ${args.attendee.email},
      ${normalizeAttendeeEmail(args.attendee.email)},
      ${args.attendee.timeZone}, ${args.attendee.phone ?? null}, ${args.attendee.notes ?? null},
      ${args.attendee.language ?? null}, ${now})`;
  // Extra attendees are written a millisecond apart, after the invitee, so
  // "the first attendee row" names the one who booked without relying on the
  // database's physical row order (see loadBookingNotificationContext).
  const insertAdditionalAttendees = additionalAttendees.map(
    (attendee, i) => sql`
      INSERT INTO booking_attendee (id, booking_id, name, email, email_normalized, time_zone, phone, notes, language, created_at)
      VALUES (${randomUUID()}, ${bookingId}, ${attendee.name}, ${attendee.email},
        ${normalizeAttendeeEmail(attendee.email)},
        ${attendee.timeZone}, ${attendee.phone ?? null}, ${attendee.notes ?? null},
        ${attendee.language ?? null}, ${now + 1 + i})`,
  );

  const record: BookingRecord = {
    uid,
    status,
    title,
    startMs,
    endMs,
    hostHandle: member.handle,
    hostName: member.display_name,
    attendee: {
      name: args.attendee.name,
      email: args.attendee.email,
      timeZone: args.attendee.timeZone,
    },
  };

  // Another caller's hold over this time, when the caller asked for holds to
  // count (`refuseHeld`), checked under the same lock as the overlap below.
  const heldByOthers = args.refuseHeld ? memberHeldSql(member.id, startMs, endMs, now, args.reservationUid) : null;

  if (db.dialect === 'sqlite') {
    // IMMEDIATE: a second API process on the same file waits for this write
    // lock and then sees this booking, as the hold write does.
    const outcome = db.sqlite!.txn<'ok' | 'conflict'>(() => {
      if (overlapExists(db, member.id, startMs, endMs)) return 'conflict';
      if (heldByOthers && db.sqlite!.drizzle.get(heldByOthers)) return 'conflict';
      db.sqlite!.drizzle.run(insertBooking);
      db.sqlite!.drizzle.run(insertAttendee);
      for (const attendee of insertAdditionalAttendees) db.sqlite!.drizzle.run(attendee);
      return 'ok';
    }, { immediate: true });
    if (outcome === 'conflict') return { ok: false, reason: 'SLOT_TAKEN' };
    if (args.reservationUid) await db.run(sql`DELETE FROM slot_reservation WHERE uid = ${args.reservationUid}`);
    // The booking is committed — burn the link (#110). AFTER the write, never
    // before: burning first would kill the link on every SLOT_TAKEN and strand
    // the invitee with a dead link and no booking. See `consumeOneOffLink`.
    if (live) await consumeOneOffLink(db, live.id, bookingId);
    return { ok: true, booking: await withCalendarText(db, record), manageToken: token };
  }

  // Postgres: async transaction; the EXCLUDE constraint is the ultimate backstop.
  const pg = db.pg!.drizzle;
  try {
    const conflicted = await pg.transaction(async (tx) => {
      // The host's row, locked: every guarded write that can give this host a
      // booking (this one, a team booking naming them as a co-host, a move, a
      // confirmation) takes it first, so two of them cannot both pass the
      // check below before either commits.
      await tx.execute(sql`SELECT id FROM member WHERE id = ${member.id} FOR UPDATE`);
      const rows = (await tx.execute(hostOverlapSql(member.id, startMs, endMs))) as unknown as Array<{
        id: string;
      }>;
      if (rows.length > 0) return true;
      if (heldByOthers && ((await tx.execute(heldByOthers)) as unknown as unknown[]).length > 0) return true;
      await tx.execute(insertBooking);
      await tx.execute(insertAttendee);
      for (const attendee of insertAdditionalAttendees) await tx.execute(attendee);
      return false;
    });
    if (conflicted) return { ok: false, reason: 'SLOT_TAKEN' };
    if (args.reservationUid) await db.run(sql`DELETE FROM slot_reservation WHERE uid = ${args.reservationUid}`);
    // Committed — burn the link (#110), same ordering as the SQLite branch.
    if (live) await consumeOneOffLink(db, live.id, bookingId);
    return { ok: true, booking: await withCalendarText(db, record), manageToken: token };
  } catch (err) {
    if (isExclusionViolation(err) || isUniqueViolation(err)) {
      return { ok: false, reason: 'SLOT_TAKEN' };
    }
    throw err;
  }
}

/** The booking as just stored: with the calendar title and body its event type's templates rendered, if any. */
async function withCalendarText(db: Db, record: BookingRecord): Promise<BookingRecord> {
  const text = await applyCalendarTemplates(db, record.uid);
  return {
    ...record,
    ...(text?.title !== undefined ? { title: text.title } : {}),
    // An emptied description ('') is none, as far as anyone reading the booking goes.
    ...(text?.description !== undefined ? { calendarDescription: text.description || null } : {}),
  };
}

/**
 * Refuses an attendee with no address once normalized (empty or blank): they
 * are nobody to `peopleOn`, so no seat count, cap or dedupe would see them and
 * the same request could take seats without end. Null when every one has one.
 */
export function attendeeWithoutAddress(
  invitee: { email: string },
  additional: ReadonlyArray<{ email: string }> | undefined,
): string | null {
  return [invitee, ...(additional ?? [])].some((attendee) => normalizeAttendeeEmail(attendee.email) === '')
    ? 'Every attendee needs an email address.'
    : null;
}

/**
 * A booking's attendees, one per address: the invitee first, then each
 * additional attendee whose address is new. The request's own repeats, and the
 * invitee's address named again, are dropped.
 */
export function distinctAttendees<T extends { email: string }>(invitee: T, additional: readonly T[] | undefined): T[] {
  return [invitee, ...(additional ?? [])].filter(
    (attendee, i, all) =>
      all.findIndex((a) => normalizeAttendeeEmail(a.email) === normalizeAttendeeEmail(attendee.email)) === i,
  );
}

/**
 * Replay lookup for a repeated idempotency key — ALWAYS account-scoped (#104).
 * This route is reachable without a credential, and the row it returns carries
 * the host, the attendee and the meeting time, so a key alone must never be
 * enough to read a booking. The account filter is the guarantee;
 * `scopedIdempotencyKey` matches how the value was written.
 */
async function findBookingByIdempotencyKey(
  db: Db,
  accountId: string,
  key: string,
): Promise<{ record: BookingRecord } | undefined> {
  const row = await db.get<{
    uid: string;
    status: string;
    title: string;
    calendar_description: string | null;
    start_ms: number;
    end_ms: number;
    host_handle: string | null;
    host_name: string | null;
    att_name: string | null;
    att_email: string | null;
    att_tz: string | null;
  }>(
    sql`SELECT b.uid, b.status, b.title, b.calendar_description, b.start_ms, b.end_ms,
               m.handle AS host_handle, m.display_name AS host_name,
               a.name AS att_name, a.email AS att_email, a.time_zone AS att_tz
        FROM booking b
        LEFT JOIN member m ON m.id = b.host_member_id
        LEFT JOIN booking_attendee a ON a.booking_id = b.id
        WHERE b.account_id = ${accountId}
          AND b.idempotency_key = ${scopedIdempotencyKey(accountId, key)} LIMIT 1`,
  );
  if (!row) return undefined;
  return {
    record: {
      uid: row.uid,
      status: row.status,
      title: row.title,
      calendarDescription: row.calendar_description,
      startMs: Number(row.start_ms),
      endMs: Number(row.end_ms),
      hostHandle: row.host_handle,
      hostName: row.host_name,
      attendee: {
        name: row.att_name ?? '',
        email: row.att_email ?? '',
        timeZone: row.att_tz ?? 'UTC',
      },
    },
  };
}
