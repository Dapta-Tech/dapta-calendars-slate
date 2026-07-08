/**
 * SQLite schema (the dev / clone-and-run default). Mirrors schema.pg.ts 1:1 —
 * identical table + column names so the repository layer is dialect-agnostic.
 *
 * Portable column choices (§ migration plan):
 *   - text UUID primary keys (app-generated via crypto.randomUUID())
 *   - instants as INTEGER epoch milliseconds (trivial overlap math; the pg
 *     mirror uses BIGINT so the anti-overlap EXCLUDE works over int8range)
 *   - dates as TEXT "YYYY-MM-DD", times as TEXT "HH:mm"
 *   - arrays / structured config as TEXT JSON (SQLite has no array/jsonb)
 */
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const account = sqliteTable('account', {
  id: text('id').primaryKey(),
  /** Public account code used in booking URLs: /<code>/<handle>/<slug>. */
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const member = sqliteTable('member', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  /** Public booking handle, unique within the account. */
  handle: text('handle'),
  displayName: text('display_name'),
  email: text('email'),
  avatarUrl: text('avatar_url'),
  timeZone: text('time_zone').notNull().default('UTC'),
  defaultScheduleId: text('default_schedule_id'),
  createdAt: integer('created_at').notNull(),
});

export const schedule = sqliteTable('schedule', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  memberId: text('member_id').notNull(),
  name: text('name').notNull(),
  timeZone: text('time_zone').notNull().default('UTC'),
  createdAt: integer('created_at').notNull(),
});

export const availability = sqliteTable('availability', {
  id: text('id').primaryKey(),
  scheduleId: text('schedule_id').notNull(),
  /** JSON array of weekday numbers (0=Sun..6=Sat) for recurring rows; null for a date override. */
  days: text('days'),
  /** Wall-clock "HH:mm" in the parent schedule's timeZone. */
  startTime: text('start_time').notNull(),
  endTime: text('end_time').notNull(),
  /** "YYYY-MM-DD" for a date-specific override; null for recurring. */
  date: text('date'),
});

export const eventType = sqliteTable('event_type', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  memberId: text('member_id').notNull(),
  slug: text('slug').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  lengthMinutes: integer('length_minutes').notNull(),
  scheduleId: text('schedule_id'),
  hidden: integer('hidden').notNull().default(0),
  minimumBookingNotice: integer('minimum_booking_notice').notNull().default(120),
  beforeEventBuffer: integer('before_event_buffer').notNull().default(0),
  afterEventBuffer: integer('after_event_buffer').notNull().default(0),
  slotInterval: integer('slot_interval'),
  createdAt: integer('created_at').notNull(),
});

export const booking = sqliteTable('booking', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  /** Opaque public id for URLs. */
  uid: text('uid').notNull().unique(),
  eventTypeId: text('event_type_id'),
  hostMemberId: text('host_member_id'),
  title: text('title').notNull(),
  /** Instant (epoch ms, UTC). */
  startMs: integer('start_ms').notNull(),
  endMs: integer('end_ms').notNull(),
  status: text('status').notNull().default('accepted'),
  location: text('location'),
  meetingUrl: text('meeting_url'),
  /** JSON. Holds the hashed manage token under _manage.tokenHash. */
  metadata: text('metadata'),
  cancellationReason: text('cancellation_reason'),
  idempotencyKey: text('idempotency_key').unique(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const bookingAttendee = sqliteTable('booking_attendee', {
  id: text('id').primaryKey(),
  bookingId: text('booking_id').notNull(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  timeZone: text('time_zone'),
  notes: text('notes'),
  createdAt: integer('created_at').notNull(),
});

export const sqliteSchema = {
  account,
  member,
  schedule,
  availability,
  eventType,
  booking,
  bookingAttendee,
};
