/**
 * Host events: something a host puts on their OWN calendar, with a title of
 * their own, any time and length, and the people they choose (none at all for
 * a block of focus time). Written by the MCP `create_event` tool.
 *
 * Stored as a `booking` row with `event_type_id = NULL` (every other write
 * names an event type, and deleting one leaves its id on the bookings, so NULL
 * marks a host event and nothing else), which keeps every read, move and
 * cancellation of a booking working on it. What sets it apart:
 *  - any start and length: no event type, so no hours, notice or slot grid;
 *  - nobody is emailed by this service: the host's connected calendar invites
 *    the attendees (see `isHostEvent` for the effects that skip it);
 *  - the overlap guard is the same as every booking's, under the same lock
 *    and, on Postgres, the same `booking_no_overlap` EXCLUDE: a host event can
 *    never overlap another of the host's bookings. What the host may choose to
 *    ignore (`allowConflicts`) is only what dCal does not own: busy time on
 *    the connected calendar and another caller's hold.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { isExclusionViolation } from '@slate/engine';
import type { CalendarProvider } from '@slate/calendar';
import type { Db } from './client';
import { loadExternalBusy, uniqueEmails } from './calendar-refs';
import { normalizeAttendeeEmail } from './duplicate-guard';
import {
  bookingStartOutOfRange,
  hostOverlapSql,
  jsonParam,
  memberHeldSql,
  parseJsonColumn,
  scopedIdempotencyKey,
} from './repository';

/** Longest host event: a day. Longer spans (a week off) are all-day events, a follow-up. */
export const HOST_EVENT_MAX_MINUTES = 24 * 60;
/** Shortest host event. */
export const HOST_EVENT_MIN_MINUTES = 5;
/** Most attendees on one host event, as on a booking's guests. */
export const HOST_EVENT_MAX_ATTENDEES = 10;
/** How many conflicts a refusal lists. */
const MAX_CONFLICTS = 10;

export interface CreateHostEventArgs {
  accountId: string;
  /** The host whose calendar gets the event: a member of `accountId`, active. */
  memberId: string;
  title: string;
  /** The event's body, plain text. */
  description?: string | null;
  /** Ask the connected calendar for a video meeting link. */
  videoLink?: boolean;
  startMs: number;
  endMs: number;
  /** Attendee emails; the host's own address and repeats are dropped. */
  attendees: string[];
  /** The zone the calendar event is written in. */
  timeZone: string;
  /** Create it even when the connected calendar or a hold says the time is busy. */
  allowConflicts?: boolean;
  /**
   * Whether the caller queues the calendar write for it (the host has a
   * calendar to write to). Kept on the event, so a replay answers what was
   * done then, not what the host's calendar is now.
   */
  calendarQueued?: boolean;
  /**
   * Retry-dedupe key, already namespaced by the caller (credential + key); the
   * account namespace is added here (`scopedIdempotencyKey`).
   */
  idempotencyKey?: string;
  /** Digest of the request, so the same key with other arguments is refused. */
  requestHash?: string;
}

/** Something already on the host's calendar at that time. */
export type HostEventConflict =
  | {
      /** A booking or host event in dCal: never overridable. */
      kind: 'booking';
      uid: string;
      /** The event type's name for a booking (its own title may name the invitee), the event's own for a host event. */
      title: string;
      status: string;
      startMs: number;
      endMs: number;
    }
  | { kind: 'hold'; startMs: number; endMs: number }
  | { kind: 'calendar'; startMs: number; endMs: number };

export type HostEventOutcome =
  | {
      ok: true;
      uid: string;
      /** True when the key had already created this event: nothing was written now. */
      replayed: boolean;
      /** The busy time the host chose to ignore (`allowConflicts`), as decided when it was made. */
      overridden: HostEventConflict[];
      /** False when the connected calendar could not be read and `allowConflicts` let it through. */
      calendarChecked: boolean;
      /** Whether its calendar write was queued (`calendarQueued`), as recorded when it was made. */
      calendarQueued: boolean;
    }
  | { ok: false; reason: 'NOT_FOUND' }
  | { ok: false; reason: 'INVALID'; message: string }
  | { ok: false; reason: 'IDEMPOTENCY_KEY_REUSED' }
  | { ok: false; reason: 'CALENDAR_UNAVAILABLE' }
  /** Overlaps another dCal booking of the host: refused whatever `allowConflicts` says. */
  | { ok: false; reason: 'SLOT_TAKEN'; conflicts: HostEventConflict[] }
  /** Busy time the host may choose to ignore, listed so they can decide. */
  | { ok: false; reason: 'CONFLICT'; conflicts: HostEventConflict[] };

/** What a host event keeps of its own creation (`metadata._hostEvent`), for replays. */
interface StoredHostEvent {
  by: 'mcp';
  calendar: 'queued' | 'not_connected';
  calendarChecked: boolean;
  overridden: HostEventConflict[];
}

/** Whether a booking row is a host event (`createHostEvent`): one with no event type. */
export function isHostEventRow(row: { event_type_id: string | null | undefined } | null | undefined): boolean {
  return !!row && row.event_type_id == null;
}

/**
 * Whether the booking `uid` is a host event. False for an unknown uid, so a
 * caller that skips a side effect for host events keeps it for everything else.
 */
export async function isHostEvent(db: Db, uid: string): Promise<boolean> {
  const row = await db.get<{ event_type_id: string | null }>(
    sql`SELECT event_type_id FROM booking WHERE uid = ${uid} LIMIT 1`,
  );
  return isHostEventRow(row);
}

/** Each address once, in order, without the host's own. */
export function hostEventAttendees(emails: readonly string[], hostEmail: string | null | undefined): string[] {
  const host = normalizeAttendeeEmail(hostEmail);
  // The calendar write's own dedupe (`uniqueEmails`), so the two never compare addresses differently.
  return uniqueEmails(emails.map((email) => email.trim())).filter((email) => normalizeAttendeeEmail(email) !== host);
}

/**
 * The dCal bookings of `memberId` over the window, as conflicts (organizer or
 * co-host), at most `limit`. @internal Shared with the series writes.
 */
export async function bookingConflicts(
  db: Db,
  memberId: string,
  startMs: number,
  endMs: number,
  limit: number = MAX_CONFLICTS,
): Promise<HostEventConflict[]> {
  const rows = await db.all<{
    uid: string;
    status: string;
    start_ms: number | string;
    end_ms: number | string;
    title: string;
    event_type_id: string | null;
    event_title: string | null;
  }>(
    sql`SELECT b.uid, b.status, b.start_ms, b.end_ms, b.title, b.event_type_id, et.title AS event_title
        FROM booking b LEFT JOIN event_type et ON et.id = b.event_type_id
        WHERE b.status IN ('accepted','pending')
          AND b.start_ms < ${endMs} AND b.end_ms > ${startMs}
          AND (b.host_member_id = ${memberId}
               OR EXISTS (SELECT 1 FROM booking_host bh WHERE bh.booking_id = b.id AND bh.member_id = ${memberId}))
        ORDER BY b.start_ms ASC, b.uid ASC
        LIMIT ${limit}`,
  );
  return rows.map((r) => ({
    kind: 'booking' as const,
    uid: r.uid,
    title: r.event_type_id == null ? r.title : (r.event_title ?? ''),
    status: r.status,
    startMs: Number(r.start_ms),
    endMs: Number(r.end_ms),
  }));
}

/** Another caller's unexpired holds on the host over the window, at most `limit`. @internal Shared with the series writes. */
export async function holdConflicts(
  db: Db,
  memberId: string,
  startMs: number,
  endMs: number,
  now: number,
  limit: number = MAX_CONFLICTS,
): Promise<HostEventConflict[]> {
  const rows = await db.all<{ slot_start_ms: number | string; slot_end_ms: number | string }>(
    sql`SELECT slot_start_ms, slot_end_ms FROM slot_reservation
        WHERE member_id = ${memberId} AND release_at_ms > ${now}
          AND slot_start_ms < ${endMs} AND slot_end_ms > ${startMs}
        ORDER BY slot_start_ms ASC LIMIT ${limit}`,
  );
  return rows.map((r) => ({ kind: 'hold' as const, startMs: Number(r.slot_start_ms), endMs: Number(r.slot_end_ms) }));
}

/**
 * The event a repeated key already made: replayed, or refused when the key came
 * with other arguments. Null when the key has made nothing. A caller may ask
 * before its own checks, so a retry is answered as the first call was, whatever
 * has changed since (the host's calendar disconnected, the time filled up).
 */
export async function replayHostEvent(
  db: Db,
  accountId: string,
  key: string,
  requestHash: string | undefined,
): Promise<HostEventOutcome | null> {
  const row = await db.get<{ uid: string; event_type_id: string | null; metadata: unknown }>(
    sql`SELECT uid, event_type_id, metadata FROM booking
        WHERE account_id = ${accountId} AND idempotency_key = ${scopedIdempotencyKey(accountId, key)} LIMIT 1`,
  );
  if (!row) return null;
  const meta = parseJsonColumn<{ _idempotency?: { requestHash?: string }; _hostEvent?: Partial<StoredHostEvent> }>(row.metadata, {});
  if (!isHostEventRow(row) || (meta._idempotency?.requestHash ?? null) !== (requestHash ?? null))
    return { ok: false, reason: 'IDEMPOTENCY_KEY_REUSED' };
  // What the first call decided: a retry learns the same, including busy time
  // the host chose to ignore and a calendar that could not be read then.
  const made = meta._hostEvent ?? {};
  return {
    ok: true,
    uid: row.uid,
    replayed: true,
    overridden: Array.isArray(made.overridden) ? made.overridden : [],
    calendarChecked: made.calendarChecked !== false,
    calendarQueued: made.calendar === 'queued',
  };
}

/**
 * The parts of a busy interval outside `own` (the time a host event being moved
 * holds now), as [start, end) epoch ms. With no `own`, the whole interval.
 */
export function busyOutside(
  interval: { start: Date; end: Date },
  own: { startMs: number; endMs: number } | null,
): Array<[number, number]> {
  const start = interval.start.getTime();
  const end = interval.end.getTime();
  if (!own) return [[start, end]];
  const parts: Array<[number, number]> = [];
  if (start < own.startMs) parts.push([start, Math.min(end, own.startMs)]);
  if (end > own.endMs) parts.push([Math.max(start, own.endMs), end]);
  return parts;
}

/**
 * The time a host event being moved holds on the calendar, when its own copy is
 * there (a written `booking_reference`): the calendar reports that copy as
 * busy, and it must not block its own move. Null for a booking, which keeps the
 * check as it was, and for an event with no copy written yet, whose old time
 * on the calendar, if busy, is busy with something else.
 *
 * The free/busy read cannot tell one event from another, so while a copy
 * exists anything else at its old time is left out of the check too: a move
 * that overlaps the old time trusts it the way the host left it.
 */
export async function hostEventOwnTime(
  db: Db,
  booking: { id: string; event_type_id: string | null; start_ms: number | string; end_ms: number | string },
): Promise<{ startMs: number; endMs: number } | null> {
  if (!isHostEventRow(booking)) return null;
  const copy = await db.get<{ id: string }>(
    sql`SELECT id FROM booking_reference
        WHERE booking_id = ${booking.id} AND type = 'calendar_event' AND external_event_id IS NOT NULL
        UNION ALL
        -- An occurrence of a repeating event: its copy is the series' event (ADR 0012).
        SELECT s.id FROM booking b JOIN host_event_series s ON s.id = b.recurring_event_id
        WHERE b.id = ${booking.id} AND s.calendar_event_id IS NOT NULL
        LIMIT 1`,
  );
  return copy ? { startMs: Number(booking.start_ms), endMs: Number(booking.end_ms) } : null;
}

/**
 * Put an event on a host's calendar (see the module comment). Reads what is
 * already there first and writes nothing when it is busy, unless the host
 * chose to ignore what they may ignore. The write itself runs under the
 * host's lock with the overlap check every booking write makes, so two writes
 * can never both pass. The calendar write-out is the caller's to enqueue.
 *
 * `calendar` is the FRESH provider (ADR 0009): a decision never reads a cache.
 */
export async function createHostEvent(
  db: Db,
  args: CreateHostEventArgs,
  calendar?: CalendarProvider,
): Promise<HostEventOutcome> {
  // Account-scoped: a member of another account is not found.
  const member = await db.get<{ id: string; status: string; email: string | null }>(
    sql`SELECT id, status, email FROM member WHERE id = ${args.memberId} AND account_id = ${args.accountId} LIMIT 1`,
  );
  if (member?.status !== 'active') return { ok: false, reason: 'NOT_FOUND' };

  const title = args.title.trim();
  if (!title) return { ok: false, reason: 'INVALID', message: 'The event needs a title.' };
  const rangeErr = bookingStartOutOfRange(args.startMs);
  if (rangeErr) return { ok: false, reason: 'INVALID', message: rangeErr };
  const minutes = (args.endMs - args.startMs) / 60_000;
  if (!Number.isFinite(minutes) || minutes < HOST_EVENT_MIN_MINUTES)
    return { ok: false, reason: 'INVALID', message: `The event must last at least ${HOST_EVENT_MIN_MINUTES} minutes.` };
  if (minutes > HOST_EVENT_MAX_MINUTES)
    return { ok: false, reason: 'INVALID', message: 'The event can last at most 24 hours.' };
  const attendees = hostEventAttendees(args.attendees, member.email);
  if (attendees.length > HOST_EVENT_MAX_ATTENDEES)
    return { ok: false, reason: 'INVALID', message: `At most ${HOST_EVENT_MAX_ATTENDEES} attendees.` };

  const key = args.idempotencyKey;
  const replay = () => (key ? replayHostEvent(db, args.accountId, key, args.requestHash) : Promise.resolve(null));
  {
    const prior = await replay();
    if (prior) return prior;
  }
  /**
   * A refusal, unless a call with the same key made the event meanwhile: a
   * retry that raced its first attempt (a timed-out call keeps running while
   * the caller retries) would otherwise read that attempt's own event as the
   * conflict. Answered as the replay it is.
   */
  const refuse = async (out: HostEventOutcome): Promise<HostEventOutcome> => (await replay()) ?? out;

  const { startMs, endMs } = args;
  const now = Date.now();
  // What is there already. dCal's own bookings are never overridable; the rest
  // only with `allowConflicts`. Read outside the lock to list them; the write
  // below checks again under it.
  const booked = await bookingConflicts(db, member.id, startMs, endMs);
  const holds = await holdConflicts(db, member.id, startMs, endMs, now);
  let external: HostEventConflict[] = [];
  let calendarChecked = true;
  try {
    const busy = await loadExternalBusy(db, calendar, member.id, startMs, endMs, null);
    external = busy
      .filter((b) => b.start.getTime() < endMs && b.end.getTime() > startMs)
      // A dCal booking is on the calendar too: list it once, as the booking.
      .filter((b) => !booked.some((k) => k.startMs === b.start.getTime() && k.endMs === b.end.getTime()))
      .sort((a, b) => a.start.getTime() - b.start.getTime())
      .slice(0, MAX_CONFLICTS)
      .map((b) => ({ kind: 'calendar' as const, startMs: b.start.getTime(), endMs: b.end.getTime() }));
  } catch {
    // Fail closed: an unreadable calendar is not a free one. Only a host who
    // already said to ignore conflicts goes ahead, and is told it was unchecked.
    if (!args.allowConflicts) return refuse({ ok: false, reason: 'CALENDAR_UNAVAILABLE' });
    calendarChecked = false;
  }
  const soft = [...holds, ...external];
  if (booked.length > 0)
    return refuse({ ok: false, reason: 'SLOT_TAKEN', conflicts: [...booked, ...soft].slice(0, MAX_CONFLICTS) });
  if (soft.length > 0 && !args.allowConflicts)
    return refuse({ ok: false, reason: 'CONFLICT', conflicts: soft.slice(0, MAX_CONFLICTS) });

  const bookingId = randomUUID();
  const uid = randomUUID();
  const description = args.description?.trim() ? args.description.trim() : null;
  // The kind decides the video link at write-out (`wantsConferencingLink`):
  // `conferencing` asks for one; `custom` with no place never does (a NULL
  // kind with no place would ask for one).
  const locationKind = args.videoLink ? 'conferencing' : 'custom';
  const overridden = args.allowConflicts ? soft : [];
  // What this creation decided, kept so a replay answers exactly that.
  const stored: StoredHostEvent = {
    by: 'mcp',
    calendar: args.calendarQueued ? 'queued' : 'not_connected',
    calendarChecked,
    overridden,
  };
  const metadata = {
    _hostEvent: stored,
    ...(key ? { _idempotency: { requestHash: args.requestHash ?? null } } : {}),
  };
  const storedKey = key ? scopedIdempotencyKey(args.accountId, key) : null;
  // `seated = 1`: the title and body are the host's own and shared with every
  // attendee, so a guest added later keeps them (`markSharedSql` leaves a
  // seated booking's text alone, and would otherwise put "Meeting" in place).
  const insertBooking = sql`
    INSERT INTO booking (id, account_id, uid, event_type_id, host_member_id, title, calendar_description,
      location, location_kind, start_ms, end_ms, status, metadata, attendee_time_zone, idempotency_key,
      seated, created_at, updated_at)
    VALUES (${bookingId}, ${args.accountId}, ${uid}, NULL, ${member.id}, ${title}, ${description},
      NULL, ${locationKind}, ${startMs}, ${endMs}, 'accepted', ${jsonParam(db, metadata)}, ${args.timeZone},
      ${storedKey}, 1, ${now}, ${now})`;
  // One row per attendee, a millisecond apart so their order is the caller's.
  const insertAttendees = attendees.map(
    (email, i) => sql`
      INSERT INTO booking_attendee (id, booking_id, name, email, email_normalized, time_zone, created_at)
      VALUES (${randomUUID()}, ${bookingId}, ${email}, ${email}, ${normalizeAttendeeEmail(email)},
        ${args.timeZone}, ${now + i})`,
  );
  // The same key already written: checked first under the lock, so a racing
  // retry sees its first attempt's event as the replay, not as an overlap.
  const keyTakenSql = storedKey
    ? sql`SELECT id FROM booking WHERE account_id = ${args.accountId} AND idempotency_key = ${storedKey} LIMIT 1`
    : null;
  // Holds count only when the host did not choose to ignore them.
  const heldSql = args.allowConflicts ? null : memberHeldSql(member.id, startMs, endMs, now);

  type Written = 'ok' | 'replay' | 'booked' | 'held';
  let written: Written;
  try {
    if (db.dialect === 'sqlite') {
      written = db.sqlite!.txn<Written>(() => {
        if (keyTakenSql && db.sqlite!.drizzle.get(keyTakenSql)) return 'replay';
        if (db.sqlite!.drizzle.get(hostOverlapSql(member.id, startMs, endMs))) return 'booked';
        if (heldSql && db.sqlite!.drizzle.get(heldSql)) return 'held';
        db.sqlite!.drizzle.run(insertBooking);
        for (const insert of insertAttendees) db.sqlite!.drizzle.run(insert);
        return 'ok';
      }, { immediate: true });
    } else {
      written = await db.pg!.drizzle.transaction(async (tx): Promise<Written> => {
        // The host's row first, as every guarded booking write takes it.
        await tx.execute(sql`SELECT id FROM member WHERE id = ${member.id} FOR UPDATE`);
        if (keyTakenSql && ((await tx.execute(keyTakenSql)) as unknown as unknown[]).length > 0) return 'replay';
        const overlap = (await tx.execute(hostOverlapSql(member.id, startMs, endMs))) as unknown as unknown[];
        if (overlap.length > 0) return 'booked';
        if (heldSql && ((await tx.execute(heldSql)) as unknown as unknown[]).length > 0) return 'held';
        await tx.execute(insertBooking);
        for (const insert of insertAttendees) await tx.execute(insert);
        return 'ok';
      });
    }
  } catch (err) {
    // A concurrent call with the same key won the unique key: answer what it wrote.
    const prior = await replay();
    if (prior) return prior;
    // The EXCLUDE constraint caught an overlap the check above could not see.
    if (!isExclusionViolation(err)) throw err;
    written = 'booked';
  }
  if (written === 'replay') return (await replay()) ?? { ok: false, reason: 'IDEMPOTENCY_KEY_REUSED' };
  if (written === 'booked')
    return refuse({ ok: false, reason: 'SLOT_TAKEN', conflicts: await bookingConflicts(db, member.id, startMs, endMs) });
  if (written === 'held')
    return refuse({ ok: false, reason: 'CONFLICT', conflicts: await holdConflicts(db, member.id, startMs, endMs, Date.now()) });
  return {
    ok: true,
    uid,
    replayed: false,
    overridden,
    calendarChecked,
    calendarQueued: args.calendarQueued === true,
  };
}
