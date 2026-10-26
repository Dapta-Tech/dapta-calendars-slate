/**
 * Test fixture: a member with one schedule and one weekly rule, written the way
 * an onboarded member has them (the member, their default schedule, its hours).
 * Shared by the specs that need hosts with known hours, so their setups cannot
 * drift apart. Specs only: excluded from the package build like the specs.
 */
import { randomUUID } from 'node:crypto';
import { sql, type Db } from './client';

export interface MemberHours {
  accountId: string;
  handle: string;
  name: string;
  email: string;
  timeZone: string;
  scheduleName: string;
  /** Weekdays the rule covers, 0 = Sunday. */
  days: readonly number[];
  /** `HH:MM` in `timeZone`. */
  startTime: string;
  endTime: string;
}

/** Insert the member, their default schedule and its weekly hours. */
export async function memberWithHours(db: Db, m: MemberHours): Promise<{ id: string; scheduleId: string }> {
  const id = randomUUID();
  const scheduleId = randomUUID();
  const createdAt = Date.now();
  await db.run(
    sql`INSERT INTO member (id, account_id, handle, display_name, email, time_zone, default_schedule_id, created_at)
        VALUES (${id}, ${m.accountId}, ${m.handle}, ${m.name}, ${m.email}, ${m.timeZone}, ${scheduleId}, ${createdAt})`,
  );
  await db.run(
    sql`INSERT INTO schedule (id, account_id, member_id, name, time_zone, created_at)
        VALUES (${scheduleId}, ${m.accountId}, ${id}, ${m.scheduleName}, ${m.timeZone}, ${createdAt})`,
  );
  await db.run(
    sql`INSERT INTO availability (id, schedule_id, days, start_time, end_time, date)
        VALUES (${randomUUID()}, ${scheduleId}, ${JSON.stringify(m.days)}, ${m.startTime}, ${m.endTime}, ${null})`,
  );
  return { id, scheduleId };
}

/** Weekdays, Monday to Friday. */
export const WEEKDAYS = [1, 2, 3, 4, 5] as const;
