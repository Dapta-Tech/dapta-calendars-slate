/**
 * Demo seed — a fresh clone shows a working public booking page immediately.
 * Idempotent: it wipes the demo account and re-inserts, so `pnpm db:seed` can
 * run repeatedly. Everything here is generic sample data (no real people).
 *
 * Seeds: one account ("acme"), one host member ("alex-rivera", America/New_York),
 * a Mon–Fri 9–17 schedule, a 30-minute "Intro Call" event type, and one existing
 * accepted booking so the double-booking guard is demonstrably exercised.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Db } from './client';

export interface SeedResult {
  accountCode: string;
  handle: string;
  slug: string;
  bookingPagePath: string;
}

export async function seed(db: Db): Promise<SeedResult> {
  const accountCode = 'acme';
  const handle = 'alex-rivera';
  const slug = 'intro-call';
  const now = Date.now();

  // Clean prior demo rows (idempotent reseed).
  const prior = await db.get<{ id: string }>(
    sql`SELECT id FROM account WHERE code = ${accountCode} LIMIT 1`,
  );
  if (prior) {
    const accountId = prior.id;
    await db.run(
      sql`DELETE FROM booking_attendee WHERE booking_id IN (SELECT id FROM booking WHERE account_id = ${accountId})`,
    );
    await db.run(sql`DELETE FROM booking WHERE account_id = ${accountId}`);
    await db.run(sql`DELETE FROM event_type WHERE account_id = ${accountId}`);
    await db.run(
      sql`DELETE FROM availability WHERE schedule_id IN (SELECT id FROM schedule WHERE account_id = ${accountId})`,
    );
    await db.run(sql`DELETE FROM schedule WHERE account_id = ${accountId}`);
    await db.run(sql`DELETE FROM member WHERE account_id = ${accountId}`);
    await db.run(sql`DELETE FROM account WHERE id = ${accountId}`);
  }

  const accountId = randomUUID();
  const memberId = randomUUID();
  const scheduleId = randomUUID();
  const eventTypeId = randomUUID();

  await db.run(
    sql`INSERT INTO account (id, code, name, created_at) VALUES (${accountId}, ${accountCode}, ${'Acme Inc.'}, ${now})`,
  );
  await db.run(
    sql`INSERT INTO member (id, account_id, handle, display_name, email, time_zone, default_schedule_id, created_at)
        VALUES (${memberId}, ${accountId}, ${handle}, ${'Alex Rivera'}, ${'alex@example.com'}, ${'America/New_York'}, ${scheduleId}, ${now})`,
  );
  await db.run(
    sql`INSERT INTO schedule (id, account_id, member_id, name, time_zone, created_at)
        VALUES (${scheduleId}, ${accountId}, ${memberId}, ${'Working Hours'}, ${'America/New_York'}, ${now})`,
  );
  // Mon–Fri 09:00–17:00 (wall-clock in America/New_York).
  await db.run(
    sql`INSERT INTO availability (id, schedule_id, days, start_time, end_time, date)
        VALUES (${randomUUID()}, ${scheduleId}, ${JSON.stringify([1, 2, 3, 4, 5])}, ${'09:00'}, ${'17:00'}, ${null})`,
  );
  await db.run(
    sql`INSERT INTO event_type (id, account_id, member_id, slug, title, description, length_minutes,
          schedule_id, hidden, minimum_booking_notice, before_event_buffer, after_event_buffer, slot_interval, created_at)
        VALUES (${eventTypeId}, ${accountId}, ${memberId}, ${slug}, ${'Intro Call'},
          ${'A 30-minute introductory call.'}, ${30}, ${scheduleId}, ${0}, ${120}, ${0}, ${0}, ${30}, ${now})`,
  );

  // One existing accepted booking tomorrow at 10:00 America/New_York, so the
  // slot at that instant is already busy — the guard has something to catch.
  const tomorrow10 = nextWeekdayAt(10, 'America/New_York');
  await db.run(
    sql`INSERT INTO booking (id, account_id, uid, event_type_id, host_member_id, title, start_ms, end_ms,
          status, metadata, created_at, updated_at)
        VALUES (${randomUUID()}, ${accountId}, ${randomUUID()}, ${eventTypeId}, ${memberId}, ${'Intro Call'},
          ${tomorrow10}, ${tomorrow10 + 30 * 60_000}, 'accepted', ${null}, ${now}, ${now})`,
  );

  return { accountCode, handle, slug, bookingPagePath: `/${accountCode}/${handle}/${slug}` };
}

/** Epoch ms for the next weekday (Mon–Fri) at the given local hour in `tz`. */
function nextWeekdayAt(hour: number, tz: string): number {
  const now = new Date();
  for (let addDays = 1; addDays <= 8; addDays++) {
    const probe = new Date(now.getTime() + addDays * 86_400_000);
    // Weekday of the probe date in the target zone.
    const weekday = new Date(
      new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
        .format(probe) + 'T00:00:00Z',
    ).getUTCDay();
    if (weekday >= 1 && weekday <= 5) {
      const [y, m, d] = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      })
        .format(probe)
        .split('-')
        .map(Number);
      // Build the wall-clock instant for hour:00 in tz (offset-corrected).
      const guess = Date.UTC(y!, m! - 1, d!, hour, 0, 0);
      const off = zoneOffsetMs(new Date(guess), tz);
      return guess - off;
    }
  }
  return now.getTime() + 86_400_000;
}

function zoneOffsetMs(instant: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);
  const map: Record<string, number> = {};
  for (const p of parts) if (p.type !== 'literal') map[p.type] = Number(p.value);
  const asUtc = Date.UTC(map.year!, map.month! - 1, map.day!, map.hour!, map.minute!, map.second!);
  return asUtc - instant.getTime();
}
