/**
 * Postgres schema — THE SOURCE OF TRUTH. Postgres is what we trust: CI runs the
 * Postgres path first-class and production is Aurora Postgres. This schema uses
 * Postgres to its full power (jsonb, the `booking_no_overlap` GiST EXCLUDE
 * constraint over int8range gated on status='accepted', proper indexes). SQLite
 * (schema.sqlite.ts) is a PORTABLE SUBSET for zero-infra dev only and never
 * limits what this schema may use — where a feature needs Postgres, we use it
 * and the SQLite-dev path degrades (documented), prod is never constrained.
 *
 * Column names mirror schema.sqlite.ts so the repository is dialect-agnostic.
 */
import { pgTable, text, bigint, integer, jsonb } from 'drizzle-orm/pg-core';

export const account = pgTable('account', {
  id: text('id').primaryKey(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});

export const member = pgTable('member', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  handle: text('handle'),
  displayName: text('display_name'),
  email: text('email'),
  avatarUrl: text('avatar_url'),
  timeZone: text('time_zone').notNull().default('UTC'),
  defaultScheduleId: text('default_schedule_id'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});

export const schedule = pgTable('schedule', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  memberId: text('member_id').notNull(),
  name: text('name').notNull(),
  timeZone: text('time_zone').notNull().default('UTC'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});

export const availability = pgTable('availability', {
  id: text('id').primaryKey(),
  scheduleId: text('schedule_id').notNull(),
  days: text('days'),
  startTime: text('start_time').notNull(),
  endTime: text('end_time').notNull(),
  date: text('date'),
});

export const eventType = pgTable('event_type', {
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
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});

export const booking = pgTable('booking', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  uid: text('uid').notNull().unique(),
  eventTypeId: text('event_type_id'),
  hostMemberId: text('host_member_id'),
  title: text('title').notNull(),
  startMs: bigint('start_ms', { mode: 'number' }).notNull(),
  endMs: bigint('end_ms', { mode: 'number' }).notNull(),
  status: text('status').notNull().default('accepted'),
  location: text('location'),
  meetingUrl: text('meeting_url'),
  // Full Postgres power: jsonb (SQLite stores the same shape as text).
  metadata: jsonb('metadata'),
  cancellationReason: text('cancellation_reason'),
  idempotencyKey: text('idempotency_key').unique(),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
  updatedAt: bigint('updated_at', { mode: 'number' }).notNull(),
});

export const bookingAttendee = pgTable('booking_attendee', {
  id: text('id').primaryKey(),
  bookingId: text('booking_id').notNull(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  timeZone: text('time_zone'),
  notes: text('notes'),
  createdAt: bigint('created_at', { mode: 'number' }).notNull(),
});

export const pgSchema = {
  account,
  member,
  schedule,
  availability,
  eventType,
  booking,
  bookingAttendee,
};
