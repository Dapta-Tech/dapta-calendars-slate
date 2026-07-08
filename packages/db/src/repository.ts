/**
 * The booking repository — the only place that turns the portable schema into
 * domain operations. Reads compose the pure @slate/engine (slot computation);
 * the write path (createBooking) enforces the anti-double-booking guarantee with
 * dual enforcement: an app-level overlap-check-in-a-transaction on BOTH engines
 * (the only backstop on SQLite), plus the DB-level EXCLUDE on Postgres (caught
 * as a 23P01 → conflict). See migration plan §5.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  computeSlots,
  generateManageToken,
  isExclusionViolation,
  isUniqueViolation,
  type AvailabilityRule,
  type Interval,
} from '@slate/engine';
import type { Db } from './client';

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

/** Build a JSON write value: cast text → jsonb on Postgres, bind text on SQLite. */
export function jsonParam(db: Db, value: unknown) {
  const text = value == null ? null : JSON.stringify(value);
  if (text == null) return sql`NULL`;
  return db.dialect === 'postgres' ? sql`${text}::jsonb` : sql`${text}`;
}

export interface AccountRow {
  id: string;
  code: string;
  name: string;
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
  schedule_id: string | null;
  scheduling_type: string | null;
  booking_fields: unknown;
  minimum_booking_notice: number;
  before_event_buffer: number;
  after_event_buffer: number;
  slot_interval: number | null;
  requires_confirmation: number;
}

export type BookingOutcome =
  | { ok: true; booking: BookingRecord; manageToken: string }
  | { ok: false; reason: 'SLOT_TAKEN' | 'NOT_FOUND' | 'RESERVATION_EXPIRED' }
  | { ok: false; reason: 'INVALID'; message: string };

export interface BookingRecord {
  uid: string;
  status: string;
  title: string;
  startMs: number;
  endMs: number;
  hostHandle: string | null;
  hostName: string | null;
  attendee: { name: string; email: string; timeZone: string };
}

export interface CreateBookingArgs {
  accountCode: string;
  handle: string;
  slug: string;
  startMs: number;
  attendee: { name: string; email: string; timeZone: string; notes?: string; phone?: string };
  /** Answers to the event type's custom intake fields. */
  answers?: Record<string, unknown>;
  /** A held reservation to consume (deleted on success). */
  reservationUid?: string;
  idempotencyKey?: string;
  /** True when a host/agent booked on behalf (attribution; skips manage-token gating upstream). */
  onBehalf?: boolean;
}

/** Validate submitted intake answers against a set of field definitions. */
export function validateIntakeAnswers(
  fields: BookingFieldDef[],
  answers: Record<string, unknown> | undefined,
): string | null {
  for (const f of fields) {
    if (!f.required) continue;
    const v = answers?.[f.name];
    const missing =
      v == null || v === '' || (Array.isArray(v) && v.length === 0) || v === false;
    if (missing) return `Missing required field: ${f.label}`;
  }
  return null;
}

// --- Resolvers ------------------------------------------------------------

export async function getAccountByCode(db: Db, code: string): Promise<AccountRow | undefined> {
  return db.get<AccountRow>(sql`SELECT id, code, name FROM account WHERE code = ${code} LIMIT 1`);
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

export async function getEventType(
  db: Db,
  accountId: string,
  memberId: string,
  slug: string,
): Promise<EventTypeRow | undefined> {
  return db.get<EventTypeRow>(
    sql`SELECT id, account_id, member_id, team_id, slug, title, description, length_minutes,
               schedule_id, scheduling_type, booking_fields, minimum_booking_notice,
               before_event_buffer, after_event_buffer, slot_interval, requires_confirmation
        FROM event_type
        WHERE account_id = ${accountId} AND member_id = ${memberId} AND slug = ${slug}
              AND hidden = 0 LIMIT 1`,
  );
}

export interface PublicProfile {
  account: { code: string; name: string };
  member: {
    handle: string;
    displayName: string | null;
    timeZone: string;
    avatarUrl: string | null;
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
  const rows = await db.all<{
    slug: string;
    title: string;
    description: string | null;
    length_minutes: number;
  }>(
    sql`SELECT slug, title, description, length_minutes FROM event_type
        WHERE account_id = ${account.id} AND member_id = ${member.id} AND hidden = 0
        ORDER BY length_minutes ASC`,
  );
  return {
    account: { code: account.code, name: account.name },
    member: {
      handle: member.handle,
      displayName: member.display_name,
      timeZone: member.time_zone,
      avatarUrl: member.avatar_url,
      coverUrl: member.cover_url,
      brandColor: member.brand_color,
      layout: member.layout,
      style: parseJsonColumn<Record<string, unknown> | null>(member.booking_page_style, null),
    },
    eventTypes: rows.map((r) => ({
      slug: r.slug,
      title: r.title,
      description: r.description,
      lengthMinutes: r.length_minutes,
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
  };
  timeZone: string;
  slots: string[];
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
): Promise<Interval[]> {
  const rows = await db.all<{ start_ms: number; end_ms: number }>(
    sql`SELECT start_ms, end_ms FROM booking
        WHERE host_member_id = ${hostMemberId} AND status IN ('accepted','pending')
              AND start_ms < ${toMs} AND end_ms > ${fromMs}`,
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

export async function getAvailability(
  db: Db,
  args: { accountCode: string; handle: string; slug: string; fromMs: number; toMs: number; displayTimeZone?: string; now?: Date },
): Promise<AvailabilityResult | undefined> {
  const account = await getAccountByCode(db, args.accountCode);
  if (!account) return undefined;
  const member = await getMember(db, account.id, args.handle);
  if (!member) return undefined;
  const eventType = await getEventType(db, account.id, member.id, args.slug);
  if (!eventType) return undefined;

  const schedule =
    (await resolveScheduleTimeZone(db, eventType.schedule_id)) ??
    (await resolveScheduleTimeZone(db, member.default_schedule_id));
  const scheduleTimeZone = schedule?.timeZone ?? member.time_zone;

  let rules: AvailabilityRule[] = [];
  if (schedule) rules = await loadAvailabilityRules(db, schedule.id);

  const busy = [
    ...(await loadBusyForHost(db, member.id, args.fromMs, args.toMs)),
    ...(await loadReservationBusy(db, member.id, args.fromMs, args.toMs, args.now?.getTime())),
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
    now: args.now ?? new Date(),
  });

  return {
    eventType: {
      slug: eventType.slug,
      title: eventType.title,
      lengthMinutes: eventType.length_minutes,
      bookingFields: parseJsonColumn<BookingFieldDef[]>(eventType.booking_fields, []),
    },
    timeZone: args.displayTimeZone ?? scheduleTimeZone,
    slots: slots.map((d) => d.toISOString()),
  };
}

// --- Create booking (the atomic, dual-enforced write) ---------------------

function overlapExists(db: Db, hostMemberId: string, startMs: number, endMs: number): boolean {
  // SQLite synchronous read via the native drizzle instance (inside a txn).
  const row = db.sqlite!.drizzle.get<{ id: string }>(
    sql`SELECT id FROM booking WHERE host_member_id = ${hostMemberId} AND status IN ('accepted','pending')
        AND start_ms < ${endMs} AND end_ms > ${startMs} LIMIT 1`,
  );
  return !!row;
}

export async function createBooking(db: Db, args: CreateBookingArgs): Promise<BookingOutcome> {
  const account = await getAccountByCode(db, args.accountCode);
  if (!account) return { ok: false, reason: 'NOT_FOUND' };
  const member = await getMember(db, account.id, args.handle);
  if (!member) return { ok: false, reason: 'NOT_FOUND' };
  const eventType = await getEventType(db, account.id, member.id, args.slug);
  if (!eventType) return { ok: false, reason: 'NOT_FOUND' };

  // Required-intake validation (server-side; never trust the client).
  const fields = parseJsonColumn<BookingFieldDef[]>(eventType.booking_fields, []);
  const invalid = validateIntakeAnswers(fields, args.answers);
  if (invalid) return { ok: false, reason: 'INVALID', message: invalid };

  // Idempotency: return the prior booking for a repeated key.
  if (args.idempotencyKey) {
    const prior = await findBookingByIdempotencyKey(db, args.idempotencyKey);
    if (prior) return { ok: true, booking: prior.record, manageToken: '' };
  }

  // Hold validation at consume: a reservation that is missing or expired → 410.
  // (The two-layer expiry: app-level release_at check here + the DB sweep.)
  if (args.reservationUid) {
    const hold = await db.get<{ release_at_ms: number }>(
      sql`SELECT release_at_ms FROM slot_reservation WHERE uid = ${args.reservationUid} LIMIT 1`,
    );
    if (!hold) return { ok: false, reason: 'RESERVATION_EXPIRED' };
    if (Number(hold.release_at_ms) <= Date.now()) {
      await db.run(sql`DELETE FROM slot_reservation WHERE uid = ${args.reservationUid}`);
      return { ok: false, reason: 'RESERVATION_EXPIRED' };
    }
  }

  const startMs = args.startMs;
  const endMs = startMs + eventType.length_minutes * 60_000;
  const now = Date.now();
  const uid = randomUUID();
  const bookingId = randomUUID();
  const attendeeId = randomUUID();
  const { token, tokenHash } = generateManageToken();
  const metadata = JSON.stringify({ _manage: { tokenHash } });
  const title = eventType.title;

  // Postgres stores metadata as jsonb (source-of-truth, full power); the bound
  // text param is cast on write. SQLite stores the same JSON as text.
  // requiresConfirmation → the booking starts 'pending' (host confirms later);
  // otherwise 'accepted'. Pending still HOLDS the slot (overlap check includes it).
  const status = eventType.requires_confirmation ? 'pending' : 'accepted';
  const metaExpr = db.dialect === 'postgres' ? sql`${metadata}::jsonb` : sql`${metadata}`;
  const responsesExpr = jsonParam(db, args.answers ?? null);
  const insertBooking = sql`
    INSERT INTO booking (id, account_id, uid, event_type_id, host_member_id, title,
      start_ms, end_ms, status, metadata, responses, attendee_time_zone, idempotency_key,
      created_at, updated_at)
    VALUES (${bookingId}, ${account.id}, ${uid}, ${eventType.id}, ${member.id}, ${title},
      ${startMs}, ${endMs}, ${status}, ${metaExpr}, ${responsesExpr}, ${args.attendee.timeZone},
      ${args.idempotencyKey ?? null}, ${now}, ${now})`;
  const insertAttendee = sql`
    INSERT INTO booking_attendee (id, booking_id, name, email, time_zone, phone, notes, created_at)
    VALUES (${attendeeId}, ${bookingId}, ${args.attendee.name}, ${args.attendee.email},
      ${args.attendee.timeZone}, ${args.attendee.phone ?? null}, ${args.attendee.notes ?? null}, ${now})`;

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

  if (db.dialect === 'sqlite') {
    const outcome = db.sqlite!.txn<'ok' | 'conflict'>(() => {
      if (overlapExists(db, member.id, startMs, endMs)) return 'conflict';
      db.sqlite!.drizzle.run(insertBooking);
      db.sqlite!.drizzle.run(insertAttendee);
      return 'ok';
    });
    if (outcome === 'conflict') return { ok: false, reason: 'SLOT_TAKEN' };
    if (args.reservationUid) await db.run(sql`DELETE FROM slot_reservation WHERE uid = ${args.reservationUid}`);
    return { ok: true, booking: record, manageToken: token };
  }

  // Postgres: async transaction; the EXCLUDE constraint is the ultimate backstop.
  const pg = db.pg!.drizzle;
  try {
    const conflicted = await pg.transaction(async (tx) => {
      const rows = (await tx.execute(
        sql`SELECT id FROM booking WHERE host_member_id = ${member.id} AND status IN ('accepted','pending')
            AND start_ms < ${endMs} AND end_ms > ${startMs} LIMIT 1`,
      )) as unknown as Array<{ id: string }>;
      if (rows.length > 0) return true;
      await tx.execute(insertBooking);
      await tx.execute(insertAttendee);
      return false;
    });
    if (conflicted) return { ok: false, reason: 'SLOT_TAKEN' };
    if (args.reservationUid) await db.run(sql`DELETE FROM slot_reservation WHERE uid = ${args.reservationUid}`);
    return { ok: true, booking: record, manageToken: token };
  } catch (err) {
    if (isExclusionViolation(err) || isUniqueViolation(err)) {
      return { ok: false, reason: 'SLOT_TAKEN' };
    }
    throw err;
  }
}

async function findBookingByIdempotencyKey(
  db: Db,
  key: string,
): Promise<{ record: BookingRecord } | undefined> {
  const row = await db.get<{
    uid: string;
    status: string;
    title: string;
    start_ms: number;
    end_ms: number;
    host_handle: string | null;
    host_name: string | null;
    att_name: string | null;
    att_email: string | null;
    att_tz: string | null;
  }>(
    sql`SELECT b.uid, b.status, b.title, b.start_ms, b.end_ms,
               m.handle AS host_handle, m.display_name AS host_name,
               a.name AS att_name, a.email AS att_email, a.time_zone AS att_tz
        FROM booking b
        LEFT JOIN member m ON m.id = b.host_member_id
        LEFT JOIN booking_attendee a ON a.booking_id = b.id
        WHERE b.idempotency_key = ${key} LIMIT 1`,
  );
  if (!row) return undefined;
  return {
    record: {
      uid: row.uid,
      status: row.status,
      title: row.title,
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
