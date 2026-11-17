/**
 * Booking limits per event type, the DB half (the rule itself is
 * `booking-limits.ts` in @slate/engine): which bookings count, read around a
 * window for the slot reads, and read again inside the locked write that
 * creates a booking, a hold or a move, so two people booking the last time of a
 * day cannot both win.
 *
 * What counts: the event's own bookings, accepted or pending, by their start.
 * Cancelled and declined ones never do. A seated time is one booking row, so it
 * counts once. A team event's limit is the event's as a whole: every host's
 * bookings count together, and its days and weeks are read in ONE zone, the
 * team's, so what the team page offers and what the write accepts agree
 * whichever host takes the time. A personal event reads them in its schedule's.
 */
import { sql } from 'drizzle-orm';
import {
  bookingLimitBreach,
  hasBookingLimits,
  type BookingLimitPeriod,
  type BookingLimits,
  type BookingLimitsInput,
  type Interval,
} from '@slate/engine';
import type { Db } from './client';

/** The four limit columns of an `event_type` row. */
export interface BookingLimitColumns {
  max_bookings_per_day: number | null;
  max_bookings_per_week: number | null;
  max_minutes_per_day: number | null;
  max_minutes_per_week: number | null;
}

/** An event row as the limits need it. */
type LimitedEvent = { id: string; account_id: string; team_id?: string | null } & Partial<BookingLimitColumns>;

/** The event's limits, or null when it has none (every event that predates them). */
export function bookingLimitsOf(row: Partial<BookingLimitColumns>): BookingLimits | null {
  const limits: BookingLimits = {
    maxBookingsPerDay: row.max_bookings_per_day ?? null,
    maxBookingsPerWeek: row.max_bookings_per_week ?? null,
    maxMinutesPerDay: row.max_minutes_per_day ?? null,
    maxMinutesPerWeek: row.max_minutes_per_week ?? null,
  };
  return hasBookingLimits(limits) ? limits : null;
}

/**
 * What a refusal says when a booking limit is why: the error codes stay those
 * of a time that is not offered (or taken meanwhile); the words say the day or
 * the week is full.
 */
export function limitReachedMessage(period: BookingLimitPeriod): string {
  return period === 'day'
    ? "That day has reached this event type's booking limit. Pick another day."
    : "That week has reached this event type's booking limit. Pick another week.";
}

/**
 * Eight days either side of a window: wide enough to hold the whole day and
 * the whole Monday-to-Sunday week of any time in it, in any zone.
 */
const SPAN_MS = 8 * 86_400_000;

/**
 * The bookings that count around [fromMs, toMs). Scoped to the event's account
 * as well as the event (DEV-34), and bounded by `end_ms` so it range-scans
 * `booking_event_type_status_end_idx` (event_type_id, status, end_ms) instead of
 * reading every booking the event ever had inside the locked write. A booking
 * ends after it starts, so the `end_ms` bound drops none of them.
 */
function countedSql(accountId: string, eventTypeId: string, fromMs: number, toMs: number, excludeBookingId?: string) {
  const except = excludeBookingId ? sql` AND id <> ${excludeBookingId}` : sql``;
  return sql`SELECT start_ms, end_ms FROM booking
      WHERE event_type_id = ${eventTypeId} AND status IN ('accepted','pending')
        AND end_ms > ${fromMs - SPAN_MS} AND account_id = ${accountId}
        AND start_ms >= ${fromMs - SPAN_MS} AND start_ms < ${toMs + SPAN_MS}${except}`;
}

type CountedRow = { start_ms: number | string; end_ms: number | string };
const intervals = (rows: CountedRow[]): Interval[] =>
  rows.map((r) => ({ start: new Date(Number(r.start_ms)), end: new Date(Number(r.end_ms)) }));

/** A team event's zone (its team's), or null for a personal event. */
async function teamZone(db: Db, teamId: string | null | undefined): Promise<string | null> {
  if (!teamId) return null;
  const row = await db.get<{ time_zone: string | null }>(sql`SELECT time_zone FROM team WHERE id = ${teamId} LIMIT 1`);
  return row?.time_zone || 'UTC';
}

/**
 * What a slot read hands `computeSlots` for an event: its limits, the bookings
 * that count around [fromMs, toMs), and, for a team event, the team's zone to
 * read them in. null when it has no limit, so an event without limits reads
 * nothing more than it did.
 *
 * `excludeBookingId`: the booking being moved, which must not count against
 * its own move. `seated`: the event has seats, so a time already booked takes
 * a seat and not another booking.
 */
export async function loadBookingLimits(
  db: Db,
  et: LimitedEvent,
  fromMs: number,
  toMs: number,
  opts: { excludeBookingId?: string; seated?: boolean } = {},
): Promise<BookingLimitsInput | null> {
  const limits = bookingLimitsOf(et);
  if (!limits) return null;
  const rows = await db.all<CountedRow>(countedSql(et.account_id, et.id, fromMs, toMs, opts.excludeBookingId));
  const zone = await teamZone(db, et.team_id);
  return { limits, booked: intervals(rows), seated: opts.seated, ...(zone ? { timeZone: zone } : {}) };
}

/** One booking the locked write is about to make, checked against its event's limits. */
export interface LimitGuard {
  accountId: string;
  eventTypeId: string;
  limits: BookingLimits;
  /** The zone its days and weeks are read in: the team's, or the schedule's. */
  timeZone: string;
  startMs: number;
  durationMin: number;
  excludeBookingId?: string;
  seated?: boolean;
}

/**
 * The guard for an event row, or null when the event has no limit (and then
 * no zone is looked up, so an event without limits reads nothing more). A team
 * event reads its team's zone; a personal one asks `scheduleZone`.
 */
export async function limitGuardFor(
  db: Db,
  et: LimitedEvent,
  scheduleZone: () => Promise<string>,
  g: Omit<LimitGuard, 'accountId' | 'eventTypeId' | 'limits' | 'timeZone'>,
): Promise<LimitGuard | null> {
  const limits = bookingLimitsOf(et);
  if (!limits) return null;
  const timeZone = (await teamZone(db, et.team_id)) ?? (await scheduleZone());
  return { ...g, accountId: et.account_id, eventTypeId: et.id, limits, timeZone };
}

const breachOf = (g: LimitGuard, rows: CountedRow[]) =>
  bookingLimitBreach({ limits: g.limits, booked: intervals(rows), seated: g.seated }, g.timeZone, g.startMs, g.durationMin);
const guardSql = (g: LimitGuard) => countedSql(g.accountId, g.eventTypeId, g.startMs, g.startMs, g.excludeBookingId);

/**
 * The same count outside any lock: which limit closed a time a slot read did
 * not offer, so the refusal can say so. Never a decision on its own; the
 * locked write decides.
 */
export async function limitBreachNow(db: Db, g: LimitGuard): Promise<BookingLimitPeriod | null> {
  return breachOf(g, await db.all<CountedRow>(guardSql(g)));
}

/**
 * SQLite, inside the write's IMMEDIATE transaction (one writer at a time across
 * processes): the limit the booking would break, or null while it still fits.
 */
export function limitGuardBreachSqlite(db: Db, g: LimitGuard): BookingLimitPeriod | null {
  return breachOf(g, db.sqlite!.drizzle.all<CountedRow>(guardSql(g)));
}

/**
 * Postgres, inside the write's transaction and AFTER its member locks: a team
 * event's hosts take different member locks, so the event's bookings are
 * counted under a transaction-scoped advisory lock of their own (taken last,
 * after any member lock, and after equal distribution's lock, which is taken
 * first, so no two writes can wait on each other in a cycle). Under READ
 * COMMITTED the count, a new statement, then sees every booking committed by
 * the write that held the lock before.
 */
export async function limitGuardBreachPg(
  tx: { execute: (query: ReturnType<typeof sql>) => Promise<unknown> },
  g: LimitGuard,
): Promise<BookingLimitPeriod | null> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`slate:booking-limits:${g.eventTypeId}`}, 0))`);
  return breachOf(g, (await tx.execute(guardSql(g))) as unknown as CountedRow[]);
}
