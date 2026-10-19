import type { Db } from '@slate/db';
import { sql } from '@slate/db';
import { ToolFailure } from './support';

/**
 * The booking list behind `list_bookings`.
 *
 * Its own query rather than `listBookings` from `@slate/db`, for three reasons
 * the tool depends on: it must return the event type (the booking `title` holds
 * the invitee's name, which a list must not carry), it must order soonest-first
 * as well as newest-first, and it must say how many people are on a booking
 * without naming them. Every read is scoped by `account_id`; the key's
 * event-type allowlist is applied in the query, so an out-of-scope booking is
 * simply absent.
 */

export interface BookingListRow {
  uid: string;
  status: string;
  startMs: number;
  endMs: number;
  eventTypeId: string;
  eventTypeTitle: string;
  primaryEmail: string | null;
  attendeeCount: number;
}

export type BookingOrder = 'asc' | 'desc';

function encodeCursor(order: BookingOrder, startMs: number, uid: string): string {
  return Buffer.from(`${order}:${startMs}:${uid}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string, order: BookingOrder): { startMs: number; uid: string } {
  const bad = () =>
    new ToolFailure('INVALID_ARGUMENT', 'cursor is not valid for this query.', 'Pass the next_cursor exactly as returned, with the same filters and order.');
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const [o, ms, ...rest] = raw.split(':');
    const uid = rest.join(':');
    if (o !== order || !uid || !Number.isFinite(Number(ms))) throw bad();
    return { startMs: Number(ms), uid };
  } catch (error) {
    throw error instanceof ToolFailure ? error : bad();
  }
}

export async function queryBookings(
  db: Db,
  args: {
    accountId: string;
    fromMs?: number;
    toMs?: number;
    status?: string;
    /** The key's allowlist; null = unrestricted, [] = nothing. */
    allowedEventTypeIds: string[] | null;
    eventTypeId?: string;
    limit: number;
    cursor?: string;
    order: BookingOrder;
  },
): Promise<{ items: BookingListRow[]; nextCursor: string | null }> {
  const conds = [sql`b.account_id = ${args.accountId}`];
  if (args.fromMs != null) conds.push(sql`b.start_ms >= ${args.fromMs}`);
  if (args.toMs != null) conds.push(sql`b.start_ms < ${args.toMs}`);
  if (args.status) conds.push(sql`b.status = ${args.status}`);
  if (args.eventTypeId) conds.push(sql`b.event_type_id = ${args.eventTypeId}`);
  if (args.allowedEventTypeIds) {
    if (args.allowedEventTypeIds.length === 0) conds.push(sql`1 = 0`);
    else {
      const list = args.allowedEventTypeIds
        .map((id) => sql`${id}`)
        .reduce((acc, cur, i) => (i === 0 ? cur : sql`${acc}, ${cur}`));
      conds.push(sql`b.event_type_id IN (${list})`);
    }
  }
  if (args.cursor) {
    const c = decodeCursor(args.cursor, args.order);
    conds.push(
      args.order === 'asc'
        ? sql`(b.start_ms > ${c.startMs} OR (b.start_ms = ${c.startMs} AND b.uid > ${c.uid}))`
        : sql`(b.start_ms < ${c.startMs} OR (b.start_ms = ${c.startMs} AND b.uid < ${c.uid}))`,
    );
  }
  const where = conds.reduce((acc, cur, i) => (i === 0 ? cur : sql`${acc} AND ${cur}`));
  const direction = args.order === 'asc' ? sql`ASC` : sql`DESC`;
  const rows = await db.all<{
    uid: string;
    status: string;
    start_ms: number;
    end_ms: number;
    event_type_id: string;
    event_title: string;
    primary_email: string | null;
    attendee_count: number | string;
  }>(
    sql`SELECT b.uid, b.status, b.start_ms, b.end_ms, b.event_type_id, et.title AS event_title,
               (SELECT ba.email FROM booking_attendee ba WHERE ba.booking_id = b.id
                  ORDER BY ba.created_at ASC, ba.id ASC LIMIT 1) AS primary_email,
               (SELECT COUNT(*) FROM booking_attendee bc WHERE bc.booking_id = b.id) AS attendee_count
        FROM booking b JOIN event_type et ON et.id = b.event_type_id
        WHERE ${where}
        ORDER BY b.start_ms ${direction}, b.uid ${direction}
        LIMIT ${args.limit + 1}`,
  );
  const hasMore = rows.length > args.limit;
  const page = hasMore ? rows.slice(0, args.limit) : rows;
  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({
      uid: r.uid,
      status: r.status,
      startMs: Number(r.start_ms),
      endMs: Number(r.end_ms),
      eventTypeId: r.event_type_id,
      eventTypeTitle: r.event_title,
      primaryEmail: r.primary_email,
      attendeeCount: Number(r.attendee_count),
    })),
    nextCursor: hasMore && last ? encodeCursor(args.order, Number(last.start_ms), last.uid) : null,
  };
}
