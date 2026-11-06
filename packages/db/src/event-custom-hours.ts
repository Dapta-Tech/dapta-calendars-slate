/**
 * Custom hours: weekly hours private to ONE event type.
 *
 * They are stored as an ordinary `schedule` + `availability` rows with
 * `schedule.event_type_id` set, and the event's `schedule_id` points at that
 * schedule. Slot generation already reads `event_type.schedule_id` first, so it
 * needs no second path. What makes the schedule private is the column: the
 * reusable-schedule reads (`listSchedules`, `getSchedule`, default promotion)
 * all skip a row that has it.
 *
 * Writes are atomic: the old hours, the new ones and the event's pointer change
 * together or not at all, so a failed save never leaves an event pointing at a
 * half-written or deleted schedule.
 */
import { randomUUID } from 'node:crypto';
import type { SQL } from 'drizzle-orm';
import type { EventCustomHours } from '@slate/types';
import { sql, type Db } from './client';

/** Run statements in one transaction on either dialect. */
async function runAtomically(db: Db, statements: SQL[]): Promise<void> {
  if (db.dialect === 'sqlite') {
    const native = db.sqlite!;
    native.txn(() => {
      for (const stmt of statements) native.drizzle.run(stmt);
    });
    return;
  }
  await db.pg!.drizzle.transaction(async (tx) => {
    for (const stmt of statements) await tx.execute(stmt);
  });
}

/** Statements that delete an event's custom hours (schedule + its rules). */
function deleteOwnedSql(eventTypeId: string): SQL[] {
  return [
    sql`DELETE FROM availability WHERE schedule_id IN (SELECT id FROM schedule WHERE event_type_id = ${eventTypeId})`,
    sql`DELETE FROM schedule WHERE event_type_id = ${eventTypeId}`,
  ];
}

/** The event's custom hours, or null when it has none. */
export async function getEventCustomHours(db: Db, eventTypeId: string): Promise<EventCustomHours | null> {
  const s = await db.get<{ id: string; time_zone: string }>(
    sql`SELECT s.id, s.time_zone FROM schedule s
        JOIN event_type e ON e.schedule_id = s.id
        WHERE s.event_type_id = ${eventTypeId} AND e.id = ${eventTypeId} LIMIT 1`,
  );
  if (!s) return null;
  const rows = await db.all<{ days: string | null; start_time: string; end_time: string }>(
    sql`SELECT days, start_time, end_time FROM availability
        WHERE schedule_id = ${s.id} AND days IS NOT NULL
        ORDER BY start_time ASC, end_time ASC, id ASC`,
  );
  return {
    timeZone: s.time_zone,
    ranges: rows.map((r) => ({
      days: [...new Set(JSON.parse(r.days!) as number[])].sort((a, b) => a - b),
      start: r.start_time,
      end: r.end_time,
    })),
  };
}

/**
 * Replace the event's custom hours and point the event at them. One rule row
 * per range (multi-day rows keep their `days` list, which the availability
 * model already supports), so the editor reads back what it wrote.
 */
export async function setEventCustomHours(
  db: Db,
  args: { accountId: string; memberId: string; eventTypeId: string; hours: EventCustomHours },
): Promise<void> {
  const scheduleId = randomUUID();
  const statements: SQL[] = [
    ...deleteOwnedSql(args.eventTypeId),
    sql`INSERT INTO schedule (id, account_id, member_id, name, time_zone, created_at, event_type_id)
        VALUES (${scheduleId}, ${args.accountId}, ${args.memberId}, ${'Custom hours'},
          ${args.hours.timeZone}, ${Date.now()}, ${args.eventTypeId})`,
  ];
  for (const r of args.hours.ranges) {
    const days = [...new Set(r.days)].sort((a, b) => a - b);
    statements.push(
      sql`INSERT INTO availability (id, schedule_id, days, start_time, end_time, date)
          VALUES (${randomUUID()}, ${scheduleId}, ${JSON.stringify(days)}, ${r.start}, ${r.end}, ${null})`,
    );
  }
  statements.push(
    sql`UPDATE event_type SET schedule_id = ${scheduleId}
        WHERE account_id = ${args.accountId} AND id = ${args.eventTypeId}`,
  );
  await runAtomically(db, statements);
}

/**
 * Stop using custom hours: the event follows `scheduleId` (null = the host's
 * working hours) and its custom hours are deleted, in one transaction.
 */
export async function clearEventCustomHours(
  db: Db,
  args: { accountId: string; eventTypeId: string; scheduleId: string | null },
): Promise<void> {
  await runAtomically(db, [
    sql`UPDATE event_type SET schedule_id = ${args.scheduleId}
        WHERE account_id = ${args.accountId} AND id = ${args.eventTypeId}`,
    ...deleteOwnedSql(args.eventTypeId),
  ]);
}

/** Delete an event's custom hours (used when the event itself is deleted). */
export async function deleteEventCustomHours(db: Db, eventTypeId: string): Promise<void> {
  await runAtomically(db, deleteOwnedSql(eventTypeId));
}

/** Whether a schedule id is some event's private custom hours. */
export async function isEventOwnedSchedule(db: Db, scheduleId: string): Promise<boolean> {
  const row = await db.get<{ id: string }>(
    sql`SELECT id FROM schedule WHERE id = ${scheduleId} AND event_type_id IS NOT NULL LIMIT 1`,
  );
  return !!row;
}
