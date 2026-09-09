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
  // The canonical public code: a 6-char unambiguous short code for new
  // accounts (see @slate/engine short-links); legacy `acct-…`/`dev-…` codes
  // are re-coded by the migrate() data fixup and kept alive in account_alias.
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  // Stable id of this account in an upstream identity service, used by the
  // `workos` auth provider to project the external tenant onto a local account.
  // Nullable + unique (NULLs distinct): seeded/local accounts have none.
  externalId: text('external_id'),
  // Premium vanity slug (globally unique, [a-z0-9-]{3,30}); when set it is the
  // canonical public code and `code` stays as a permanent alias.
  vanitySlug: text('vanity_slug'),
  // Cached IAM verdict ('paid' | 'free'; NULL = never checked) + check time.
  // IAM is the source of truth — this is never a Calendars-side billing state.
  daptaEntitlement: text('dapta_entitlement'),
  entitlementCheckedAt: integer('entitlement_checked_at'),
  // Onboarding gate 1 (ADR 0002): the workspace's qualification answers, keyed
  // by Forms' question bank. Written once, alongside the claim below.
  // Postgres `jsonb` ↔ SQLite `text` JSON, per the dual-dialect parity rule.
  onboarding: text('onboarding'),
  // The write-once qualification claim. NULL means "this account still owes
  // onboarding" — which is why migration 0012 STAMPS every pre-existing account,
  // so the wizard greets new signups only and never traps an existing host.
  onboardingCompletedAt: integer('onboarding_completed_at'),
  // O2 growth attribution: the 7-key allowlist blob captured at the front door
  // and claimed WRITE-ONCE onto this account. NULL is the truthful state for
  // organic traffic and for every account predating the migration — nothing
  // backfills it, because a synthetic value here can never be corrected.
  // Postgres `jsonb` ↔ SQLite `text` JSON, per the dual-dialect parity rule.
  attribution: text('attribution'),
  // The write-once attribution claim. Also refuses accounts older than the
  // 10-minute window, so a campaign click by the owner of an established
  // workspace can never restamp its origin.
  attributionClaimedAt: integer('attribution_claimed_at'),
  createdAt: integer('created_at').notNull(),
});

/**
 * Retired public codes (legacy `acct-…`/`dev-…`, re-coded short codes): each
 * alias permanently resolves to its account so no shared link ever breaks —
 * the web layer 308-redirects alias URLs to the canonical code.
 */
export const accountAlias = sqliteTable('account_alias', {
  alias: text('alias').primaryKey(),
  accountId: text('account_id').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const member = sqliteTable('member', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  // Stable id of this member's user in an upstream identity service (the JWT
  // `sub`). Unique per account; the `workos` provider resolves/creates the
  // member projection by it. Nullable: seeded/local members have none.
  externalId: text('external_id'),
  handle: text('handle'),
  displayName: text('display_name'),
  email: text('email'),
  // Account-level role (distinct from team_membership.role): `owner` | `admin` |
  // `member`. Every account keeps ≥1 owner (last-owner guard). Default `member`;
  // the first member of an account is promoted to `owner` (seed + migration backfill).
  role: text('role').notNull().default('member'),
  // Lifecycle: `active` | `invited` (invited-by-email, not yet signed in) |
  // `disabled` (revoked access, row kept for history). Default `active`.
  status: text('status').notNull().default('active'),
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
  bio: text('bio'),
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
  /**
   * Per-event reminders + follow-up (#68), JSON text. NULL = never configured
   * (the read falls back to the shipped defaults); `[]` = deliberately none.
   */
  reminders: text('reminders'),
  metadata: text('metadata'),
  minimumBookingNotice: integer('minimum_booking_notice').notNull().default(120),
  beforeEventBuffer: integer('before_event_buffer').notNull().default(0),
  afterEventBuffer: integer('after_event_buffer').notNull().default(0),
  slotInterval: integer('slot_interval'),
  requiresConfirmation: integer('requires_confirmation').notNull().default(0),
  /**
   * Duplicate-booking guard (#69/AB1): 1 = one normalized email may hold at
   * most one UPCOMING booking on this event type. Off (0) by default and off
   * on every already-saved event — turning it on is the host's choice. Not a
   * security control: email is verified nowhere, so it prevents accidents.
   */
  preventDuplicateBookings: integer('prevent_duplicate_bookings').notNull().default(0),
  seatsPerTimeSlot: integer('seats_per_time_slot'),
  /** Per-event calendar write destination override; NULL = fall back to the
   *  host's member-level `is_destination` calendar (calendar-refs.ts). */
  destinationCalendarId: text('destination_calendar_id'),
  createdAt: integer('created_at').notNull(),
});

/**
 * Per-event conflict-calendar override: the set of `connected_calendar` rows
 * THIS event checks for conflicts. Empty for an event = fall back to the
 * host's member-level `check_conflicts` calendars (calendar-refs.ts).
 */
export const eventTypeConflictCalendar = sqliteTable('event_type_conflict_calendar', {
  eventTypeId: text('event_type_id').notNull(),
  connectedCalendarId: text('connected_calendar_id').notNull(),
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
  /** Human detail of the Where (address, number, custom label). */
  location: text('location'),
  /**
   * The event type's location kind, SNAPSHOTTED at booking time. Null for rows
   * written before the kind existed — the render falls back to `location`.
   */
  locationKind: text('location_kind'),
  meetingUrl: text('meeting_url'),
  attendeeTimeZone: text('attendee_time_zone'),
  responses: text('responses'),
  metadata: text('metadata'),
  cancellationReason: text('cancellation_reason'),
  cancelledBy: text('cancelled_by'),
  rescheduled: integer('rescheduled'),
  fromReschedule: text('from_reschedule'),
  rescheduledFromUid: text('rescheduled_from_uid'),
  rescheduledToUid: text('rescheduled_to_uid'),
  reschedulingReason: text('rescheduling_reason'),
  rescheduledByEmail: text('rescheduled_by_email'),
  recurringEventId: text('recurring_event_id'),
  /** Namespaced by account before it is stored (#104) — this `unique` is
   *  GLOBAL, so a raw caller-supplied key would be claimable across
   *  tenants. Go through `scopedIdempotencyKey` on every read and write. */
  idempotencyKey: text('idempotency_key').unique(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const bookingAttendee = sqliteTable('booking_attendee', {
  id: text('id').primaryKey(),
  bookingId: text('booking_id').notNull(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  /**
   * `lower(trim(email))`, indexed, for the duplicate-booking guard (#69/AB1).
   * NULLABLE on purpose, unlike `booking_guest.email_normalized`: migrations
   * land before the API that writes this column, so rows inserted in that
   * window carry NULL. Every read coalesces — see `normalizedEmailSql`.
   * `+tags` are NOT stripped (#69: most providers treat them as distinct).
   */
  emailNormalized: text('email_normalized'),
  timeZone: text('time_zone'),
  phone: text('phone'),
  notes: text('notes'),
  createdAt: integer('created_at').notNull(),
});

/** Post-create guests. Kept separate so case-insensitive dedupe has a safe unique key. */
export const bookingGuest = sqliteTable('booking_guest', {
  id: text('id').primaryKey(),
  bookingId: text('booking_id').notNull(),
  email: text('email').notNull(),
  emailNormalized: text('email_normalized').notNull(),
  name: text('name'),
  timeZone: text('time_zone'),
  createdAt: integer('created_at').notNull(),
});

/** Assigned host set for multi-host bookings (collective / fixed_round_robin). */
export const bookingHost = sqliteTable('booking_host', {
  id: text('id').primaryKey(),
  bookingId: text('booking_id').notNull(),
  memberId: text('member_id').notNull(),
  isFixed: integer('is_fixed').notNull().default(0),
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
  /** Persisted health (last explicit probe): NULL last_check_at = never checked. */
  lastCheckAt: integer('last_check_at'),
  lastCheckOk: integer('last_check_ok'),
  lastCheckDetail: text('last_check_detail'),
});

/** Provider calendars discovered beneath a connected account/credential. */
export const providerCalendar = sqliteTable('provider_calendar', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  memberId: text('member_id').notNull(),
  connectedCalendarId: text('connected_calendar_id').notNull(),
  externalId: text('external_id').notNull(),
  name: text('name').notNull(),
  email: text('email'),
  isPrimary: integer('is_primary').notNull().default(0),
  readOnly: integer('read_only').notNull().default(1),
  accessRole: text('access_role').notNull().default('none'),
  source: text('source').notNull().default('shared'),
  canRead: integer('can_read').notNull().default(1),
  canReadFreeBusy: integer('can_read_free_busy').notNull().default(1),
  canCreate: integer('can_create').notNull().default(0),
  canUpdate: integer('can_update').notNull().default(0),
  canDelete: integer('can_delete').notNull().default(0),
  syncStatus: text('sync_status').notNull().default('healthy'),
  lastSyncedAt: integer('last_synced_at'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/** Hashed, tenant/key/path-scoped mutation replay records (never stores plaintext keys). */
export const apiIdempotency = sqliteTable('api_idempotency', {
  id: text('id').primaryKey(),
  namespaceHash: text('namespace_hash').notNull().unique(),
  accountId: text('account_id').notNull(),
  apiKeyId: text('api_key_id').notNull(),
  method: text('method').notNull(),
  path: text('path').notNull(),
  requestHash: text('request_hash').notNull(),
  statusCode: integer('status_code'),
  responseBody: text('response_body'),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
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
  /** LEGACY plaintext signing secret (W / #75). Read-only fallback: rows written
   *  before the envelope still sign, and are re-sealed into `secretCipher` the
   *  first time a key is present at signing time. Never written with a plaintext
   *  value by new code — only cleared to NULL on re-seal. */
  secret: text('secret'),
  /** AES-256-GCM envelope (`v1.<iv>.<tag>.<ciphertext>`) bound to
   *  `${accountId}:webhook:${id}`. Decrypted ONLY at signing time. */
  secretCipher: text('secret_cipher'),
  eventTriggers: text('event_triggers'),
  active: integer('active').notNull().default(1),
  createdAt: integer('created_at').notNull(),
});

export const bookingReference = sqliteTable('booking_reference', {
  id: text('id').primaryKey(),
  bookingId: text('booking_id').notNull(),
  /** DH1: destination (connection ref) this event was written to; UNIQUE with booking_id. */
  destination: text('destination'),
  type: text('type').notNull(),
  externalEventId: text('external_event_id'),
  externalCalendarId: text('external_calendar_id'),
  meetingUrl: text('meeting_url'),
  createdAt: integer('created_at').notNull(),
});

/** B7/DM1: durable side-effect queue (calendar write-out + webhook delivery). */
export const outbox = sqliteTable('outbox', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(),
  action: text('action').notNull(),
  bookingUid: text('booking_uid'),
  accountId: text('account_id'),
  webhookId: text('webhook_id'),
  payload: text('payload'),
  status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(5),
  nextAttemptAt: integer('next_attempt_at').notNull(),
  lastError: text('last_error'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/**
 * Per-account notification controls (toggles + template overrides). Absent row
 * = shipped default (enabled, stock template); subject/body NULL = stock
 * template; reminder_lead_minutes = TEXT JSON array (reminder key only).
 */
export const notificationSetting = sqliteTable('notification_setting', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  emailKey: text('email_key').notNull(),
  enabled: integer('enabled').notNull().default(1),
  subject: text('subject'),
  body: text('body'),
  reminderLeadMinutes: text('reminder_lead_minutes'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/**
 * H1a (#63 / ADR 0001): ONE third-party integration credential per (account,
 * provider). The pasted private-app token is stored AES-256-GCM encrypted under
 * a `v1.<iv>.<tag>.<ciphertext>` envelope bound to (account_id, provider), and
 * is NEVER returned to a client — `label` + `token_last4` are the whole of what
 * a status view may show.
 *
 * Disconnecting is a SOFT delete: `status = 'disconnected'` and `token_cipher`
 * nulled. The row's `id` must survive, because `booking_reference.destination`
 * points at it — a hard delete would mint a new id on reconnect, orphan every
 * stored reference, and turn the first post-reconnect cancellation into a
 * duplicate meeting.
 *
 * Health mirrors `connected_calendar.last_check_*` so the two read alike, plus
 * `last_error_detail`: the STRUCTURED provider error (category + the missing
 * scope names), so a UI can name the exact checkbox that was missed rather than
 * re-parsing prose.
 */
export const accountIntegration = sqliteTable('account_integration', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  /** Vendor key, e.g. `hubspot`. UNIQUE with account_id. */
  provider: text('provider').notNull(),
  /** `connected` | `unhealthy` | `disconnected`. Never auto-disabled. */
  status: text('status').notNull().default('connected'),
  /** `v1.<iv>.<tag>.<ciphertext>`; NULL once disconnected (credential scrubbed). */
  tokenCipher: text('token_cipher'),
  label: text('label'),
  tokenLast4: text('token_last4'),
  lastCheckAt: integer('last_check_at'),
  lastCheckOk: integer('last_check_ok'),
  lastCheckDetail: text('last_check_detail'),
  /** Structured provider error: `{ category, requiredGranularScopes }` as TEXT JSON. */
  lastErrorDetail: text('last_error_detail'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
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
  eventTypeConflictCalendar,
  booking,
  bookingAttendee,
  bookingGuest,
  bookingHost,
  slotReservation,
  connectedCalendar,
  providerCalendar,
  apiIdempotency,
  apiKey,
  webhook,
  bookingReference,
  outbox,
  notificationSetting,
  accountIntegration,
};
