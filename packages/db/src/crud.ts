/**
 * Admin CRUD repository — event-types, schedules (+ availability), teams
 * (+ members), the write paths the dashboard needs. Same portable/Postgres-first
 * shape as the rest of the repository. All ops are account-scoped by the caller.
 */
import { randomUUID } from 'node:crypto';
import { parseEventLocation, type EventLocation, type EventLocationInput } from '@slate/engine';
import { sql, type Db } from './client';
import { jsonParam, parseJsonColumn } from './repository';
import {
  defaultEventReminders,
  effectiveReminders,
  normalizeEventReminders,
  parseEventReminders,
  type EventReminder,
} from './reminders';

export type CrudResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      reason: 'NOT_FOUND' | 'SLUG_TAKEN' | 'CONFLICT' | 'LAST_OWNER' | 'EMAIL_TAKEN';
      message?: string;
    };

// --- Event types ----------------------------------------------------------

/** A team event host with its round-robin weighting + fixed flag. */
export interface HostDetail {
  memberId: string;
  priority: number | null;
  weight: number | null;
  isFixed: boolean;
}

export interface EventTypeView {
  id: string;
  memberId: string | null;
  teamId: string | null;
  slug: string;
  title: string;
  description: string | null;
  lengthMinutes: number;
  /** Normalized from `event_type.locations`, which may still hold legacy text. */
  location: EventLocation | null;
  scheduleId: string | null;
  hidden: boolean;
  schedulingType: string | null;
  minimumBookingNotice: number;
  beforeEventBuffer: number;
  afterEventBuffer: number;
  slotInterval: number | null;
  requiresConfirmation: boolean;
  seatsPerTimeSlot: number | null;
  bookingFields: unknown[];
  /** Reminders + follow-up owned by this event type (#68). NULL in the column
   *  means "never configured" — the view surfaces the shipped defaults so the
   *  editor opens on what this event actually sends. */
  reminders: EventReminder[];
  hostMemberIds: string[];
  /** Per-host priority/weight/fixed (team events); empty for personal events. */
  hosts: HostDetail[];
  /**
   * PHASE 2 — per-event calendar selection (personal events only). Empty ⇒ the
   * event falls back to the host's member-level `check_conflicts` calendars.
   */
  conflictCalendarIds: string[];
  /** PHASE 2 — the connected_calendar this event writes booked events to; null
   *  ⇒ falls back to the host's member-level `is_destination` calendar. */
  destinationCalendarId: string | null;
}

interface EventTypeDbRow {
  id: string;
  member_id: string | null;
  team_id: string | null;
  slug: string;
  title: string;
  description: string | null;
  length_minutes: number;
  locations: unknown;
  schedule_id: string | null;
  hidden: number;
  scheduling_type: string | null;
  minimum_booking_notice: number;
  before_event_buffer: number;
  after_event_buffer: number;
  slot_interval: number | null;
  requires_confirmation: number;
  seats_per_time_slot: number | null;
  booking_fields: unknown;
  reminders: unknown;
  destination_calendar_id: string | null;
}

const ET_COLS = sql`id, member_id, team_id, slug, title, description, length_minutes, locations,
  schedule_id, hidden, scheduling_type, minimum_booking_notice, before_event_buffer,
  after_event_buffer, slot_interval, requires_confirmation, seats_per_time_slot, booking_fields,
  reminders, destination_calendar_id`;

async function toEventTypeView(db: Db, r: EventTypeDbRow): Promise<EventTypeView> {
  const hosts = await db.all<{ member_id: string; is_fixed: number; priority: number | null; weight: number | null }>(
    sql`SELECT member_id, is_fixed, priority, weight FROM event_type_host WHERE event_type_id = ${r.id}`,
  );
  const conflictCalendars = await db.all<{ connected_calendar_id: string }>(
    sql`SELECT connected_calendar_id FROM event_type_conflict_calendar WHERE event_type_id = ${r.id}`,
  );
  return {
    id: r.id,
    memberId: r.member_id,
    teamId: r.team_id,
    slug: r.slug,
    title: r.title,
    description: r.description,
    lengthMinutes: r.length_minutes,
    location: parseEventLocation(parseJsonColumn<unknown>(r.locations, null)),
    scheduleId: r.schedule_id,
    hidden: !!r.hidden,
    schedulingType: r.scheduling_type,
    minimumBookingNotice: r.minimum_booking_notice,
    beforeEventBuffer: r.before_event_buffer,
    afterEventBuffer: r.after_event_buffer,
    slotInterval: r.slot_interval,
    requiresConfirmation: !!r.requires_confirmation,
    seatsPerTimeSlot: r.seats_per_time_slot,
    bookingFields: parseJsonColumn<unknown[]>(r.booking_fields, []),
    reminders: effectiveReminders(parseEventReminders(r.reminders)),
    hostMemberIds: hosts.map((h) => h.member_id),
    hosts: hosts.map((h) => ({
      memberId: h.member_id,
      priority: h.priority,
      weight: h.weight,
      isFixed: h.is_fixed === 1,
    })),
    conflictCalendarIds: conflictCalendars.map((c) => c.connected_calendar_id),
    destinationCalendarId: r.destination_calendar_id,
  };
}

/** Keep only ids that are `connected_calendar` rows owned by `memberId` —
 *  cross-member/cross-account ids are silently dropped (same discipline as
 *  `setEventTypeHostsDetailed`'s cross-tenant member filter). Deduplicated
 *  (optibot #32 fix): `conflictCalendarIds` is a bare `z.array(z.string())`
 *  with no uniqueness constraint, so a client resubmitting the same id twice
 *  would otherwise reach `setEventTypeConflictCalendars`'s INSERT loop twice
 *  for the same `(event_type_id, connected_calendar_id)` PRIMARY KEY pair —
 *  an unhandled constraint violation (500), not a validation error. */
async function ownedCalendarIds(db: Db, memberId: string, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db.all<{ id: string }>(sql`SELECT id FROM connected_calendar WHERE member_id = ${memberId}`);
  const owned = new Set(rows.map((r) => r.id));
  return [...new Set(ids)].filter((id) => owned.has(id));
}

/** Validate a destination-calendar id belongs to `memberId`; missing/foreign → null
 *  (never silently point an event at someone else's calendar). */
async function ownedDestinationCalendarId(
  db: Db,
  memberId: string,
  id: string | null | undefined,
): Promise<string | null> {
  if (!id) return null;
  const row = await db.get<{ id: string }>(
    sql`SELECT id FROM connected_calendar WHERE id = ${id} AND member_id = ${memberId} LIMIT 1`,
  );
  return row ? id : null;
}

/**
 * Replace the per-event conflict-calendar override for `eventTypeId` with
 * `connectedCalendarIds` (only ids owned by `memberId` are kept). An empty
 * array clears the override — the event falls back to the member default.
 */
export async function setEventTypeConflictCalendars(
  db: Db,
  eventTypeId: string,
  memberId: string,
  connectedCalendarIds: string[],
): Promise<void> {
  const owned = await ownedCalendarIds(db, memberId, connectedCalendarIds);
  await db.run(sql`DELETE FROM event_type_conflict_calendar WHERE event_type_id = ${eventTypeId}`);
  const now = Date.now();
  for (const connectedCalendarId of owned) {
    await db.run(
      sql`INSERT INTO event_type_conflict_calendar (event_type_id, connected_calendar_id, created_at)
          VALUES (${eventTypeId}, ${connectedCalendarId}, ${now})`,
    );
  }
}

export async function listEventTypes(
  db: Db,
  accountId: string,
  opts: { memberId?: string; teamId?: string } = {},
): Promise<EventTypeView[]> {
  const conds = [sql`account_id = ${accountId}`];
  if (opts.memberId) conds.push(sql`member_id = ${opts.memberId}`);
  if (opts.teamId) conds.push(sql`team_id = ${opts.teamId}`);
  const where = conds.reduce((a, c, i) => (i === 0 ? c : sql`${a} AND ${c}`));
  const rows = await db.all<EventTypeDbRow>(
    sql`SELECT ${ET_COLS} FROM event_type WHERE ${where} ORDER BY created_at ASC`,
  );
  return Promise.all(rows.map((r) => toEventTypeView(db, r)));
}

export async function getEventTypeById(
  db: Db,
  accountId: string,
  id: string,
): Promise<EventTypeView | null> {
  const r = await db.get<EventTypeDbRow>(
    sql`SELECT ${ET_COLS} FROM event_type WHERE account_id = ${accountId} AND id = ${id} LIMIT 1`,
  );
  return r ? toEventTypeView(db, r) : null;
}

export interface EventTypeInputRepo {
  slug: string;
  title: string;
  description?: string | null;
  lengthMinutes: number;
  /** The kind object, or a legacy free-text string — both are normalized on write. */
  location?: EventLocationInput | string | null;
  scheduleId?: string | null;
  hidden?: boolean;
  schedulingType?: string | null;
  minimumBookingNotice?: number;
  beforeEventBuffer?: number;
  afterEventBuffer?: number;
  slotInterval?: number | null;
  requiresConfirmation?: boolean;
  seatsPerTimeSlot?: number | null;
  bookingFields?: unknown[];
  /** Reminders + follow-up (#68). UNDEFINED on create ⇒ the shipped pre-fill
   *  (24h + 1h on, follow-up off); an EMPTY array is a deliberate "none". */
  reminders?: EventReminder[];
  hostMemberIds?: string[];
  /** Per-host detail (priority/weight/fixed). Takes precedence over hostMemberIds. */
  hosts?: HostDetailInput[];
  teamId?: string | null;
  /**
   * PHASE 2 — per-event calendar selection (personal events only; ignored for
   * team events — Phase 3). Empty array clears the override.
   */
  conflictCalendarIds?: string[];
  /** PHASE 2 — the connected_calendar this event writes to; null clears the
   *  override (falls back to the host's member-level destination). */
  destinationCalendarId?: string | null;
}

/** Host detail as accepted on input — every weighting field is optional. */
export interface HostDetailInput {
  memberId: string;
  priority?: number | null;
  weight?: number | null;
  isFixed?: boolean;
}

export async function createEventType(
  db: Db,
  accountId: string,
  memberId: string | null,
  input: EventTypeInputRepo,
): Promise<CrudResult<EventTypeView>> {
  const ownerCond = input.teamId
    ? sql`team_id = ${input.teamId}`
    : sql`member_id = ${memberId}`;
  const clash = await db.get<{ id: string }>(
    sql`SELECT id FROM event_type WHERE account_id = ${accountId} AND ${ownerCond} AND slug = ${input.slug} LIMIT 1`,
  );
  if (clash) return { ok: false, reason: 'SLUG_TAKEN', message: 'That slug is already in use.' };

  const id = randomUUID();
  const now = Date.now();
  // PHASE 2 (personal events only — team events keep no per-event calendar
  // config, Phase 3): validate the destination against the OWNER member's own
  // connected calendars before it ever reaches the row.
  const ownerMemberId = input.teamId ? null : memberId;
  const destinationCalendarId = ownerMemberId
    ? await ownedDestinationCalendarId(db, ownerMemberId, input.destinationCalendarId)
    : null;
  await db.run(
    sql`INSERT INTO event_type (id, account_id, member_id, team_id, slug, title, description,
          length_minutes, locations, schedule_id, hidden, scheduling_type, booking_fields, reminders,
          minimum_booking_notice, before_event_buffer, after_event_buffer, slot_interval,
          requires_confirmation, seats_per_time_slot, destination_calendar_id, created_at)
        VALUES (${id}, ${accountId}, ${ownerMemberId}, ${input.teamId ?? null},
          ${input.slug}, ${input.title}, ${input.description ?? null}, ${input.lengthMinutes},
          ${jsonParam(db, parseEventLocation(input.location ?? null))}, ${input.scheduleId ?? null}, ${input.hidden ? 1 : 0},
          ${input.schedulingType ?? null},
          ${jsonParam(db, input.bookingFields ?? null)},
          ${jsonParam(db, normalizeEventReminders(input.reminders ?? defaultEventReminders()))},
          ${input.minimumBookingNotice ?? 120},
          ${input.beforeEventBuffer ?? 0}, ${input.afterEventBuffer ?? 0}, ${input.slotInterval ?? null},
          ${input.requiresConfirmation ? 1 : 0}, ${input.seatsPerTimeSlot ?? null}, ${destinationCalendarId}, ${now})`,
  );
  if (input.hosts) await setEventTypeHostsDetailed(db, accountId, id, input.hosts);
  else if (input.hostMemberIds) await setEventTypeHosts(db, accountId, id, input.hostMemberIds);
  if (ownerMemberId && input.conflictCalendarIds) {
    await setEventTypeConflictCalendars(db, id, ownerMemberId, input.conflictCalendarIds);
  }
  const view = await getEventTypeById(db, accountId, id);
  return { ok: true, value: view! };
}

export async function updateEventType(
  db: Db,
  accountId: string,
  id: string,
  input: Partial<EventTypeInputRepo>,
): Promise<CrudResult<EventTypeView>> {
  const existing = await getEventTypeById(db, accountId, id);
  if (!existing) return { ok: false, reason: 'NOT_FOUND' };

  const sets: ReturnType<typeof sql>[] = [];
  const set = (col: string, val: ReturnType<typeof sql>) => sets.push(sql`${sql.raw(col)} = ${val}`);
  if (input.slug !== undefined) set('slug', sql`${input.slug}`);
  if (input.title !== undefined) set('title', sql`${input.title}`);
  if (input.description !== undefined) set('description', sql`${input.description ?? null}`);
  if (input.lengthMinutes !== undefined) set('length_minutes', sql`${input.lengthMinutes}`);
  // Normalize on write so the column converges on the kind shape: a legacy
  // string in, a `{ kind, detail }` object stored.
  if (input.location !== undefined)
    set('locations', jsonParam(db, parseEventLocation(input.location ?? null)));
  if (input.scheduleId !== undefined) set('schedule_id', sql`${input.scheduleId ?? null}`);
  if (input.hidden !== undefined) set('hidden', sql`${input.hidden ? 1 : 0}`);
  if (input.schedulingType !== undefined) set('scheduling_type', sql`${input.schedulingType ?? null}`);
  if (input.minimumBookingNotice !== undefined) set('minimum_booking_notice', sql`${input.minimumBookingNotice}`);
  if (input.beforeEventBuffer !== undefined) set('before_event_buffer', sql`${input.beforeEventBuffer}`);
  if (input.afterEventBuffer !== undefined) set('after_event_buffer', sql`${input.afterEventBuffer}`);
  if (input.slotInterval !== undefined) set('slot_interval', sql`${input.slotInterval ?? null}`);
  if (input.requiresConfirmation !== undefined) set('requires_confirmation', sql`${input.requiresConfirmation ? 1 : 0}`);
  if (input.seatsPerTimeSlot !== undefined) set('seats_per_time_slot', sql`${input.seatsPerTimeSlot ?? null}`);
  if (input.bookingFields !== undefined) set('booking_fields', jsonParam(db, input.bookingFields ?? null));
  // An empty array is a deliberate "no reminders" and is stored as `[]`, never
  // as NULL — NULL would read back as the shipped defaults and hand the host
  // back the reminder they just deleted.
  if (input.reminders !== undefined)
    set('reminders', jsonParam(db, normalizeEventReminders(input.reminders)));

  // PHASE 2 (personal events only — team events, `existing.teamId` set, keep no
  // per-event calendar config, Phase 3): validate against the OWNER member's
  // (existing.memberId) own connected calendars, never the caller's.
  const isPersonal = !existing.teamId && !!existing.memberId;
  if (isPersonal && input.destinationCalendarId !== undefined) {
    const validated = await ownedDestinationCalendarId(db, existing.memberId!, input.destinationCalendarId);
    set('destination_calendar_id', sql`${validated}`);
  }

  if (sets.length > 0) {
    const assign = sets.reduce((a, c, i) => (i === 0 ? c : sql`${a}, ${c}`));
    await db.run(sql`UPDATE event_type SET ${assign} WHERE account_id = ${accountId} AND id = ${id}`);
  }
  if (input.hosts) await setEventTypeHostsDetailed(db, accountId, id, input.hosts);
  else if (input.hostMemberIds) await setEventTypeHosts(db, accountId, id, input.hostMemberIds);
  if (isPersonal && input.conflictCalendarIds !== undefined) {
    await setEventTypeConflictCalendars(db, id, existing.memberId!, input.conflictCalendarIds);
  }
  const view = await getEventTypeById(db, accountId, id);
  return { ok: true, value: view! };
}

export async function deleteEventType(db: Db, accountId: string, id: string): Promise<boolean> {
  await db.run(sql`DELETE FROM event_type_host WHERE event_type_id = ${id}`);
  await db.run(sql`DELETE FROM event_type_conflict_calendar WHERE event_type_id = ${id}`);
  await db.run(sql`DELETE FROM event_type WHERE account_id = ${accountId} AND id = ${id}`);
  return true;
}

/**
 * Replace the round-robin host pool for an event type. Only members that belong
 * to `accountId` are inserted — a foreign memberId (cross-tenant) is silently
 * dropped, never added to the pool.
 */
export async function setEventTypeHosts(
  db: Db,
  accountId: string,
  eventTypeId: string,
  memberIds: string[],
): Promise<void> {
  await setEventTypeHostsDetailed(
    db,
    accountId,
    eventTypeId,
    memberIds.map((memberId) => ({ memberId, priority: null, weight: 100, isFixed: false })),
  );
}

/**
 * Replace the host pool with per-host round-robin detail (priority/weight/fixed).
 * Only members of `accountId` are inserted — a cross-tenant memberId is dropped.
 */
export async function setEventTypeHostsDetailed(
  db: Db,
  accountId: string,
  eventTypeId: string,
  hosts: HostDetailInput[],
): Promise<void> {
  const owned = await db.all<{ id: string }>(
    sql`SELECT id FROM member WHERE account_id = ${accountId}`,
  );
  const ownedIds = new Set(owned.map((o) => o.id));
  await db.run(sql`DELETE FROM event_type_host WHERE event_type_id = ${eventTypeId}`);
  const now = Date.now();
  for (const h of hosts) {
    if (!ownedIds.has(h.memberId)) continue; // reject cross-account members
    await db.run(
      sql`INSERT INTO event_type_host (id, account_id, event_type_id, member_id, is_fixed, priority, weight, schedule_id, created_at)
          VALUES (${randomUUID()}, ${accountId}, ${eventTypeId}, ${h.memberId}, ${h.isFixed ? 1 : 0},
            ${h.priority ?? null}, ${h.weight ?? 100}, ${null}, ${now})`,
    );
  }
}

// --- Schedules + availability ---------------------------------------------

export interface ScheduleView {
  id: string;
  memberId: string;
  name: string;
  timeZone: string;
  rules: Array<{ id: string; days: number[] | null; startTime: string; endTime: string; date: string | null }>;
}

export async function listSchedules(db: Db, memberId: string): Promise<{ id: string; name: string; timeZone: string }[]> {
  return db.all<{ id: string; name: string; timeZone: string }>(
    sql`SELECT id, name, time_zone AS "timeZone" FROM schedule WHERE member_id = ${memberId} ORDER BY created_at ASC`,
  );
}

export async function getSchedule(db: Db, accountId: string, id: string): Promise<ScheduleView | null> {
  const s = await db.get<{ id: string; member_id: string; name: string; time_zone: string }>(
    sql`SELECT id, member_id, name, time_zone FROM schedule WHERE account_id = ${accountId} AND id = ${id} LIMIT 1`,
  );
  if (!s) return null;
  const rules = await db.all<{ id: string; days: string | null; start_time: string; end_time: string; date: string | null }>(
    sql`SELECT id, days, start_time, end_time, date FROM availability WHERE schedule_id = ${id}`,
  );
  return {
    id: s.id,
    memberId: s.member_id,
    name: s.name,
    timeZone: s.time_zone,
    rules: rules.map((r) => ({
      id: r.id,
      days: r.days ? (JSON.parse(r.days) as number[]) : null,
      startTime: r.start_time,
      endTime: r.end_time,
      date: r.date,
    })),
  };
}

export async function createSchedule(
  db: Db,
  accountId: string,
  memberId: string,
  input: { name: string; timeZone: string; rules?: Array<{ days: number[] | null; startTime: string; endTime: string; date: string | null }> },
): Promise<ScheduleView> {
  const id = randomUUID();
  await db.run(
    sql`INSERT INTO schedule (id, account_id, member_id, name, time_zone, created_at)
        VALUES (${id}, ${accountId}, ${memberId}, ${input.name}, ${input.timeZone}, ${Date.now()})`,
  );
  if (input.rules) await setScheduleRules(db, id, input.rules);
  // A member's FIRST schedule becomes their default. The availability
  // classifier falls back to `member.default_schedule_id`; before this,
  // nothing outside the demo seed ever wrote it, so real users saw
  // NO_SCHEDULE ("You don't have a schedule yet") even with hours configured.
  // Guarded update (tenant-scoped): never steals an existing default.
  await db.run(
    sql`UPDATE member SET default_schedule_id = ${id}
        WHERE id = ${memberId} AND account_id = ${accountId} AND default_schedule_id IS NULL`,
  );
  return (await getSchedule(db, accountId, id))!;
}

/** Mon–Fri 09:00–17:00 — the sensible starter schedule (matches Cal.com/Calendly). */
export const DEFAULT_WORKING_HOURS_RULES: Array<{
  days: number[] | null;
  startTime: string;
  endTime: string;
  date: string | null;
}> = [{ days: [1, 2, 3, 4, 5], startTime: '09:00', endTime: '17:00', date: null }];

/**
 * The hard invariant: a member must never be left with `default_schedule_id =
 * NULL` (the root cause of the NO_SCHEDULE dead end for brand-new hosts). Idempotent
 * and safe to call on every read — a member who already has a default is a
 * single indexed SELECT and a no-op. Only members with NO default get a fresh
 * "Working hours" schedule (Mon-Fri 9-5) in their real timezone (falling back to
 * whatever `member.time_zone` currently holds, 'UTC' if truly unknown).
 */
export async function ensureDefaultSchedule(
  db: Db,
  accountId: string,
  memberId: string,
  timeZone?: string,
): Promise<{ created: boolean; scheduleId: string }> {
  const member = await db.get<{ default_schedule_id: string | null; time_zone: string }>(
    sql`SELECT default_schedule_id, time_zone FROM member WHERE id = ${memberId} LIMIT 1`,
  );
  if (member?.default_schedule_id) {
    return { created: false, scheduleId: member.default_schedule_id };
  }
  const tz = timeZone || member?.time_zone || 'UTC';
  const created = await createSchedule(db, accountId, memberId, {
    name: 'Working hours',
    timeZone: tz,
    rules: DEFAULT_WORKING_HOURS_RULES,
  });
  return { created: true, scheduleId: created.id };
}

export async function updateSchedule(
  db: Db,
  accountId: string,
  id: string,
  input: { name?: string; timeZone?: string; rules?: Array<{ days: number[] | null; startTime: string; endTime: string; date: string | null }> },
): Promise<CrudResult<ScheduleView>> {
  const existing = await getSchedule(db, accountId, id);
  if (!existing) return { ok: false, reason: 'NOT_FOUND' };
  if (input.name !== undefined || input.timeZone !== undefined) {
    await db.run(
      sql`UPDATE schedule SET name = ${input.name ?? existing.name}, time_zone = ${input.timeZone ?? existing.timeZone}
          WHERE id = ${id}`,
    );
  }
  if (input.rules) await setScheduleRules(db, id, input.rules);
  return { ok: true, value: (await getSchedule(db, accountId, id))! };
}

/** Replace ALL availability rows for a schedule (blocks + overrides). */
export async function setScheduleRules(
  db: Db,
  scheduleId: string,
  rules: Array<{ days: number[] | null; startTime: string; endTime: string; date: string | null }>,
): Promise<void> {
  await db.run(sql`DELETE FROM availability WHERE schedule_id = ${scheduleId}`);
  for (const r of rules) {
    await db.run(
      sql`INSERT INTO availability (id, schedule_id, days, start_time, end_time, date)
          VALUES (${randomUUID()}, ${scheduleId}, ${r.days ? JSON.stringify(r.days) : null},
            ${r.startTime}, ${r.endTime}, ${r.date ?? null})`,
    );
  }
}

export async function deleteSchedule(db: Db, accountId: string, id: string): Promise<void> {
  // Ownership check first — it also gates the reference re-pointing below so a
  // cross-tenant id can never touch another account's rows.
  const sched = await db.get<{ member_id: string }>(
    sql`SELECT member_id FROM schedule WHERE account_id = ${accountId} AND id = ${id} LIMIT 1`,
  );
  if (!sched) return;

  // Never leave a dangling schedule reference (the silent "slots: []" bug):
  // events fall back to the member default (NULL = default at read time), and a
  // member default that pointed here re-points to their oldest other schedule.
  await db.run(
    sql`UPDATE event_type SET schedule_id = NULL
        WHERE account_id = ${accountId} AND schedule_id = ${id}`,
  );
  await db.run(sql`UPDATE event_type_host SET schedule_id = NULL WHERE schedule_id = ${id}`);
  const fallback = await db.get<{ id: string }>(
    sql`SELECT id FROM schedule WHERE member_id = ${sched.member_id} AND id <> ${id}
        ORDER BY created_at ASC, id ASC LIMIT 1`,
  );
  await db.run(
    sql`UPDATE member SET default_schedule_id = ${fallback?.id ?? null}
        WHERE default_schedule_id = ${id}`,
  );

  await db.run(sql`DELETE FROM availability WHERE schedule_id = ${id}`);
  await db.run(sql`DELETE FROM schedule WHERE account_id = ${accountId} AND id = ${id}`);
}

// --- Teams ----------------------------------------------------------------

export interface TeamView {
  id: string;
  name: string;
  slug: string | null;
  bio: string | null;
  logoUrl: string | null;
  timeZone: string;
  hideBranding: boolean;
}

export async function listTeams(db: Db, accountId: string): Promise<TeamView[]> {
  const rows = await db.all<{ id: string; name: string; slug: string | null; bio: string | null; logo_url: string | null; time_zone: string; hide_branding: number }>(
    sql`SELECT id, name, slug, bio, logo_url, time_zone, hide_branding FROM team WHERE account_id = ${accountId} ORDER BY created_at ASC`,
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    bio: r.bio,
    logoUrl: r.logo_url,
    timeZone: r.time_zone,
    hideBranding: !!r.hide_branding,
  }));
}

export async function getTeamById(db: Db, accountId: string, id: string): Promise<TeamView | null> {
  const teams = await listTeams(db, accountId);
  return teams.find((t) => t.id === id) ?? null;
}

export async function createTeam(
  db: Db,
  accountId: string,
  input: { name: string; slug: string; bio?: string | null; logoUrl?: string | null; timeZone?: string; hideBranding?: boolean },
): Promise<CrudResult<TeamView>> {
  const clash = await db.get<{ id: string }>(
    sql`SELECT id FROM team WHERE account_id = ${accountId} AND slug = ${input.slug} LIMIT 1`,
  );
  if (clash) return { ok: false, reason: 'SLUG_TAKEN', message: 'That team slug is in use.' };
  const id = randomUUID();
  await db.run(
    sql`INSERT INTO team (id, account_id, name, slug, bio, logo_url, time_zone, hide_branding, created_at)
        VALUES (${id}, ${accountId}, ${input.name}, ${input.slug}, ${input.bio ?? null}, ${input.logoUrl ?? null},
          ${input.timeZone ?? 'UTC'}, ${input.hideBranding ? 1 : 0}, ${Date.now()})`,
  );
  return { ok: true, value: (await getTeamById(db, accountId, id))! };
}

export async function updateTeam(
  db: Db,
  accountId: string,
  id: string,
  input: { name?: string; slug?: string; bio?: string | null; logoUrl?: string | null; timeZone?: string; hideBranding?: boolean },
): Promise<CrudResult<TeamView>> {
  const existing = await getTeamById(db, accountId, id);
  if (!existing) return { ok: false, reason: 'NOT_FOUND' };
  await db.run(
    sql`UPDATE team SET name = ${input.name ?? existing.name}, slug = ${input.slug ?? existing.slug},
        bio = ${input.bio !== undefined ? input.bio : existing.bio},
        logo_url = ${input.logoUrl !== undefined ? input.logoUrl : existing.logoUrl},
        time_zone = ${input.timeZone ?? existing.timeZone},
        hide_branding = ${input.hideBranding !== undefined ? (input.hideBranding ? 1 : 0) : existing.hideBranding ? 1 : 0}
        WHERE account_id = ${accountId} AND id = ${id}`,
  );
  return { ok: true, value: (await getTeamById(db, accountId, id))! };
}

export async function deleteTeam(db: Db, accountId: string, id: string): Promise<CrudResult<{ id: string }>> {
  // Orphan guard: don't delete a team that still owns event types.
  const et = await db.get<{ id: string }>(
    sql`SELECT id FROM event_type WHERE account_id = ${accountId} AND team_id = ${id} LIMIT 1`,
  );
  if (et) return { ok: false, reason: 'CONFLICT', message: 'Delete the team’s event types first.' };
  await db.run(sql`DELETE FROM team_membership WHERE team_id = ${id}`);
  await db.run(sql`DELETE FROM team WHERE account_id = ${accountId} AND id = ${id}`);
  return { ok: true, value: { id } };
}

/** Team membership listing — scoped: only if the team belongs to `accountId`. */
export async function listTeamMembers(db: Db, accountId: string, teamId: string) {
  return db.all<{ member_id: string; role: string; accepted: number; display_name: string | null; email: string | null }>(
    sql`SELECT tm.member_id, tm.role, tm.accepted, m.display_name, m.email
        FROM team_membership tm
        JOIN member m ON m.id = tm.member_id
        JOIN team t ON t.id = tm.team_id
        WHERE tm.team_id = ${teamId} AND t.account_id = ${accountId}`,
  );
}

/**
 * Add a member to a team. Both the team and the member being added must belong
 * to the caller's account — a foreign team or member is NOT_FOUND (no
 * cross-tenant roster reads or writes).
 */
export async function addTeamMember(
  db: Db,
  accountId: string,
  teamId: string,
  memberId: string,
  role = 'member',
): Promise<CrudResult<{ id: string }>> {
  const team = await db.get<{ id: string }>(
    sql`SELECT id FROM team WHERE id = ${teamId} AND account_id = ${accountId} LIMIT 1`,
  );
  if (!team) return { ok: false, reason: 'NOT_FOUND' };
  const member = await db.get<{ id: string }>(
    sql`SELECT id FROM member WHERE id = ${memberId} AND account_id = ${accountId} LIMIT 1`,
  );
  if (!member) return { ok: false, reason: 'NOT_FOUND' };
  const existing = await db.get<{ id: string }>(
    sql`SELECT id FROM team_membership WHERE team_id = ${teamId} AND member_id = ${memberId} LIMIT 1`,
  );
  if (existing) return { ok: true, value: { id: existing.id } };
  const id = randomUUID();
  await db.run(
    sql`INSERT INTO team_membership (id, account_id, team_id, member_id, role, accepted, created_at)
        VALUES (${id}, ${accountId}, ${teamId}, ${memberId}, ${role}, 1, ${Date.now()})`,
  );
  return { ok: true, value: { id } };
}

/**
 * Remove a member — scoped so only teams in `accountId` can be altered. Guards
 * the LAST owner: a team must always keep at least one owner (F14/DL6), so
 * removing the sole owner is refused.
 */
export async function removeTeamMember(
  db: Db,
  accountId: string,
  teamId: string,
  memberId: string,
): Promise<CrudResult<{ id: string }>> {
  const row = await db.get<{ role: string }>(
    sql`SELECT tm.role FROM team_membership tm
        WHERE tm.team_id = ${teamId} AND tm.member_id = ${memberId}
          AND tm.team_id IN (SELECT id FROM team WHERE account_id = ${accountId}) LIMIT 1`,
  );
  if (!row) return { ok: true, value: { id: memberId } }; // already gone — idempotent
  if (row.role === 'owner') {
    const owners = await db.get<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM team_membership
          WHERE team_id = ${teamId} AND role = 'owner' AND member_id <> ${memberId}`,
    );
    if (Number(owners?.n ?? 0) === 0)
      return { ok: false, reason: 'LAST_OWNER', message: 'A team must keep at least one owner.' };
  }
  await db.run(
    sql`DELETE FROM team_membership WHERE team_id = ${teamId} AND member_id = ${memberId}
        AND team_id IN (SELECT id FROM team WHERE account_id = ${accountId})`,
  );
  return { ok: true, value: { id: memberId } };
}

/** Change a member's role (owner|member), scoped to the account. */
export async function updateTeamMemberRole(
  db: Db,
  accountId: string,
  teamId: string,
  memberId: string,
  role: 'owner' | 'member',
): Promise<CrudResult<{ id: string }>> {
  const row = await db.get<{ role: string }>(
    sql`SELECT role FROM team_membership WHERE team_id = ${teamId} AND member_id = ${memberId}
        AND team_id IN (SELECT id FROM team WHERE account_id = ${accountId}) LIMIT 1`,
  );
  if (!row) return { ok: false, reason: 'NOT_FOUND' };
  // Demoting the last owner would orphan the team.
  if (row.role === 'owner' && role === 'member') {
    const owners = await db.get<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM team_membership
          WHERE team_id = ${teamId} AND role = 'owner' AND member_id <> ${memberId}`,
    );
    if (Number(owners?.n ?? 0) === 0)
      return { ok: false, reason: 'LAST_OWNER', message: 'A team must keep at least one owner.' };
  }
  await db.run(
    sql`UPDATE team_membership SET role = ${role} WHERE team_id = ${teamId} AND member_id = ${memberId}`,
  );
  return { ok: true, value: { id: memberId } };
}

/** List all members of an account (for team member pickers, host selection). */
export async function listAccountMembers(db: Db, accountId: string) {
  return db.all<{ id: string; handle: string | null; display_name: string | null; email: string | null }>(
    sql`SELECT id, handle, display_name, email FROM member WHERE account_id = ${accountId} ORDER BY created_at ASC`,
  );
}
