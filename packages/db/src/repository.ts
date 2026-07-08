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
  time_zone: string;
  default_schedule_id: string | null;
}
export interface EventTypeRow {
  id: string;
  account_id: string;
  member_id: string;
  slug: string;
  title: string;
  description: string | null;
  length_minutes: number;
  schedule_id: string | null;
  minimum_booking_notice: number;
  before_event_buffer: number;
  after_event_buffer: number;
  slot_interval: number | null;
}

export type BookingOutcome =
  | { ok: true; booking: BookingRecord; manageToken: string }
  | { ok: false; reason: 'SLOT_TAKEN' | 'NOT_FOUND' };

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
  attendee: { name: string; email: string; timeZone: string; notes?: string };
  idempotencyKey?: string;
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
    sql`SELECT id, account_id, handle, display_name, email, time_zone, default_schedule_id
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
    sql`SELECT id, account_id, member_id, slug, title, description, length_minutes, schedule_id,
               minimum_booking_notice, before_event_buffer, after_event_buffer, slot_interval
        FROM event_type
        WHERE account_id = ${accountId} AND member_id = ${memberId} AND slug = ${slug}
              AND hidden = 0 LIMIT 1`,
  );
}

export interface PublicProfile {
  account: { code: string; name: string };
  member: { handle: string; displayName: string | null; timeZone: string };
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
    member: { handle: member.handle, displayName: member.display_name, timeZone: member.time_zone },
    eventTypes: rows.map((r) => ({
      slug: r.slug,
      title: r.title,
      description: r.description,
      lengthMinutes: r.length_minutes,
    })),
  };
}

// --- Availability ---------------------------------------------------------

export interface AvailabilityResult {
  eventType: { slug: string; title: string; lengthMinutes: number };
  timeZone: string;
  slots: string[];
}

async function loadAvailabilityRules(db: Db, scheduleId: string): Promise<AvailabilityRule[]> {
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

async function loadBusyForHost(
  db: Db,
  hostMemberId: string,
  fromMs: number,
  toMs: number,
): Promise<Interval[]> {
  const rows = await db.all<{ start_ms: number; end_ms: number }>(
    sql`SELECT start_ms, end_ms FROM booking
        WHERE host_member_id = ${hostMemberId} AND status = 'accepted'
              AND start_ms < ${toMs} AND end_ms > ${fromMs}`,
  );
  return rows.map((r) => ({ start: new Date(Number(r.start_ms)), end: new Date(Number(r.end_ms)) }));
}

async function resolveScheduleTimeZone(
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

  const busy = await loadBusyForHost(db, member.id, args.fromMs, args.toMs);

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
    },
    timeZone: args.displayTimeZone ?? scheduleTimeZone,
    slots: slots.map((d) => d.toISOString()),
  };
}

// --- Create booking (the atomic, dual-enforced write) ---------------------

function overlapExists(db: Db, hostMemberId: string, startMs: number, endMs: number): boolean {
  // SQLite synchronous read via the native drizzle instance (inside a txn).
  const row = db.sqlite!.drizzle.get<{ id: string }>(
    sql`SELECT id FROM booking WHERE host_member_id = ${hostMemberId} AND status = 'accepted'
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

  // Idempotency: return the prior booking for a repeated key.
  if (args.idempotencyKey) {
    const prior = await findBookingByIdempotencyKey(db, args.idempotencyKey);
    if (prior) return { ok: true, booking: prior.record, manageToken: '' };
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

  const insertBooking = sql`
    INSERT INTO booking (id, account_id, uid, event_type_id, host_member_id, title,
      start_ms, end_ms, status, metadata, idempotency_key, created_at, updated_at)
    VALUES (${bookingId}, ${account.id}, ${uid}, ${eventType.id}, ${member.id}, ${title},
      ${startMs}, ${endMs}, 'accepted', ${metadata},
      ${args.idempotencyKey ?? null}, ${now}, ${now})`;
  const insertAttendee = sql`
    INSERT INTO booking_attendee (id, booking_id, name, email, time_zone, notes, created_at)
    VALUES (${attendeeId}, ${bookingId}, ${args.attendee.name}, ${args.attendee.email},
      ${args.attendee.timeZone}, ${args.attendee.notes ?? null}, ${now})`;

  const record: BookingRecord = {
    uid,
    status: 'accepted',
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
    return outcome === 'conflict'
      ? { ok: false, reason: 'SLOT_TAKEN' }
      : { ok: true, booking: record, manageToken: token };
  }

  // Postgres: async transaction; the EXCLUDE constraint is the ultimate backstop.
  const pg = db.pg!.drizzle;
  try {
    const conflicted = await pg.transaction(async (tx) => {
      const rows = (await tx.execute(
        sql`SELECT id FROM booking WHERE host_member_id = ${member.id} AND status = 'accepted'
            AND start_ms < ${endMs} AND end_ms > ${startMs} LIMIT 1`,
      )) as unknown as Array<{ id: string }>;
      if (rows.length > 0) return true;
      await tx.execute(insertBooking);
      await tx.execute(insertAttendee);
      return false;
    });
    return conflicted
      ? { ok: false, reason: 'SLOT_TAKEN' }
      : { ok: true, booking: record, manageToken: token };
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
