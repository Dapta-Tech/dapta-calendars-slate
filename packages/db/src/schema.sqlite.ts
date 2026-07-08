/**
 * SQLite schema — a PORTABLE SUBSET of the Postgres source-of-truth
 * (schema.pg.ts), for zero-infra local dev only. Mirrors Postgres 1:1 on
 * table/column names (so the repository is dialect-agnostic). Where Postgres
 * uses jsonb / the GiST EXCLUDE constraint, SQLite uses text / an app-level
 * check. SQLite never dictates the schema — Postgres does; this only tracks it.
 *
 * Portable column choices: text UUID PKs (crypto.randomUUID()), instants as
 * INTEGER epoch-ms, dates "YYYY-MM-DD" / times "HH:mm" as TEXT, booleans as
 * INTEGER 0/1, arrays / structured config as TEXT JSON.
 */
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const account = sqliteTable('account', {
  id: text('id').primaryKey(),
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const member = sqliteTable('member', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  handle: text('handle'),
  displayName: text('display_name'),
  email: text('email'),
  avatarUrl: text('avatar_url'),
  coverUrl: text('cover_url'),
  brandColor: text('brand_color'),
  layout: text('layout'),
  bookingPageStyle: text('booking_page_style'),
  timeZone: text('time_zone').notNull().default('UTC'),
  weekStart: text('week_start').notNull().default('sunday'),
  locale: text('locale'),
  timeFormat: integer('time_format').notNull().default(12),
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
  days: text('days'),
  startTime: text('start_time').notNull(),
  endTime: text('end_time').notNull(),
  date: text('date'),
});

export const team = sqliteTable('team', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  name: text('name').notNull(),
  slug: text('slug'),
  logoUrl: text('logo_url'),
  timeZone: text('time_zone').notNull().default('UTC'),
  hideBranding: integer('hide_branding').notNull().default(0),
  createdAt: integer('created_at').notNull(),
});

export const teamMembership = sqliteTable('team_membership', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  teamId: text('team_id').notNull(),
  memberId: text('member_id').notNull(),
  role: text('role').notNull().default('member'),
  accepted: integer('accepted').notNull().default(0),
  createdAt: integer('created_at').notNull(),
});

export const eventType = sqliteTable('event_type', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  memberId: text('member_id'),
  teamId: text('team_id'),
  slug: text('slug').notNull(),
  title: text('title').notNull(),
  description: text('description'),
  lengthMinutes: integer('length_minutes').notNull(),
  scheduleId: text('schedule_id'),
  hidden: integer('hidden').notNull().default(0),
  schedulingType: text('scheduling_type'),
  locations: text('locations'),
  bookingFields: text('booking_fields'),
  metadata: text('metadata'),
  minimumBookingNotice: integer('minimum_booking_notice').notNull().default(120),
  beforeEventBuffer: integer('before_event_buffer').notNull().default(0),
  afterEventBuffer: integer('after_event_buffer').notNull().default(0),
  slotInterval: integer('slot_interval'),
  requiresConfirmation: integer('requires_confirmation').notNull().default(0),
  seatsPerTimeSlot: integer('seats_per_time_slot'),
  createdAt: integer('created_at').notNull(),
});

export const eventTypeHost = sqliteTable('event_type_host', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  eventTypeId: text('event_type_id').notNull(),
  memberId: text('member_id').notNull(),
  isFixed: integer('is_fixed').notNull().default(0),
  priority: integer('priority'),
  weight: integer('weight'),
  scheduleId: text('schedule_id'),
  createdAt: integer('created_at').notNull(),
});

export const booking = sqliteTable('booking', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  uid: text('uid').notNull().unique(),
  eventTypeId: text('event_type_id'),
  hostMemberId: text('host_member_id'),
  teamId: text('team_id'),
  title: text('title').notNull(),
  startMs: integer('start_ms').notNull(),
  endMs: integer('end_ms').notNull(),
  status: text('status').notNull().default('accepted'),
  location: text('location'),
  meetingUrl: text('meeting_url'),
  attendeeTimeZone: text('attendee_time_zone'),
  responses: text('responses'),
  metadata: text('metadata'),
  cancellationReason: text('cancellation_reason'),
  cancelledBy: text('cancelled_by'),
  rescheduled: integer('rescheduled'),
  fromReschedule: text('from_reschedule'),
  recurringEventId: text('recurring_event_id'),
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
  phone: text('phone'),
  notes: text('notes'),
  createdAt: integer('created_at').notNull(),
});

export const slotReservation = sqliteTable('slot_reservation', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  eventTypeId: text('event_type_id').notNull(),
  memberId: text('member_id').notNull(),
  slotStartMs: integer('slot_start_ms').notNull(),
  slotEndMs: integer('slot_end_ms').notNull(),
  uid: text('uid').notNull(),
  releaseAtMs: integer('release_at_ms').notNull(),
  isSeat: integer('is_seat').notNull().default(0),
  createdAt: integer('created_at').notNull(),
});

export const connectedCalendar = sqliteTable('connected_calendar', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  memberId: text('member_id').notNull(),
  /** Generic provider key (e.g. "google" | "outlook"); NO vendor bridge name. */
  provider: text('provider').notNull(),
  externalId: text('external_id').notNull(),
  primaryEmail: text('primary_email'),
  isDestination: integer('is_destination').notNull().default(0),
  checkConflicts: integer('check_conflicts').notNull().default(1),
  createdAt: integer('created_at').notNull(),
});

export const apiKey = sqliteTable('api_key', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  name: text('name').notNull(),
  prefix: text('prefix').notNull().unique(),
  last4: text('last4').notNull(),
  keyHash: text('key_hash').notNull().unique(),
  scopes: text('scopes'),
  eventTypeIds: text('event_type_ids'),
  lastUsedAtMs: integer('last_used_at_ms'),
  expiresAtMs: integer('expires_at_ms'),
  revokedAtMs: integer('revoked_at_ms'),
  createdAt: integer('created_at').notNull(),
});

export const webhook = sqliteTable('webhook', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  memberId: text('member_id'),
  teamId: text('team_id'),
  eventTypeId: text('event_type_id'),
  subscriberUrl: text('subscriber_url').notNull(),
  secret: text('secret'),
  eventTriggers: text('event_triggers'),
  active: integer('active').notNull().default(1),
  createdAt: integer('created_at').notNull(),
});

export const bookingReference = sqliteTable('booking_reference', {
  id: text('id').primaryKey(),
  bookingId: text('booking_id').notNull(),
  type: text('type').notNull(),
  externalEventId: text('external_event_id'),
  externalCalendarId: text('external_calendar_id'),
  meetingUrl: text('meeting_url'),
  createdAt: integer('created_at').notNull(),
});

export const sqliteSchema = {
  account,
  member,
  schedule,
  availability,
  team,
  teamMembership,
  eventType,
  eventTypeHost,
  booking,
  bookingAttendee,
  slotReservation,
  connectedCalendar,
  apiKey,
  webhook,
  bookingReference,
};
