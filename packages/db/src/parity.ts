/**
 * Parity repository — the modules ported from the original service beyond the
 * core booking path: reservation holds, identity/multi-tenant, branding/studio
 * persistence, teams + round-robin, reschedule/cancel, host bookings, and the
 * connections/api-keys/webhooks surfaces. Same clean/portable/Postgres-first
 * shape as repository.ts (raw portable SQL through the Db handle, JSON via the
 * parseJsonColumn/jsonParam helpers).
 */
import { randomUUID, createHash, randomBytes, createHmac } from 'node:crypto';
import {
  computeSlots,
  generateManageToken,
  selectLuckyHost,
  verifyManageToken,
  type AvailabilityRule,
  type HostCandidate,
  type Interval,
} from '@slate/engine';
import { sql, type Db } from './client';
import {
  getAccountByCode,
  getEventType,
  getMember,
  jsonParam,
  loadAvailabilityRules,
  loadBusyForHost,
  loadReservationBusy,
  parseJsonColumn,
  resolveScheduleTimeZone,
  type BookingFieldDef,
} from './repository';

// --- Reservation holds ----------------------------------------------------

const DEFAULT_HOLD_MS = 10 * 60_000;

export async function releaseReservation(db: Db, uid: string): Promise<void> {
  await db.run(sql`DELETE FROM slot_reservation WHERE uid = ${uid}`);
}

export async function sweepExpiredReservations(db: Db, now = Date.now()): Promise<void> {
  await db.run(sql`DELETE FROM slot_reservation WHERE release_at_ms <= ${now}`);
}

export interface ReserveResult {
  uid: string;
  releaseAtMs: number;
}

export async function reserveSlot(
  db: Db,
  args: { accountCode: string; handle: string; slug: string; startMs: number; holdMs?: number },
): Promise<ReserveResult | null> {
  const account = await getAccountByCode(db, args.accountCode);
  if (!account) return null;
  const member = await getMember(db, account.id, args.handle);
  if (!member) return null;
  const eventType = await getEventType(db, account.id, member.id, args.slug);
  if (!eventType) return null;

  const endMs = args.startMs + eventType.length_minutes * 60_000;
  const uid = randomUUID();
  const now = Date.now();
  const releaseAtMs = now + (args.holdMs ?? DEFAULT_HOLD_MS);
  await db.run(
    sql`INSERT INTO slot_reservation (id, account_id, event_type_id, member_id, slot_start_ms,
          slot_end_ms, uid, release_at_ms, is_seat, created_at)
        VALUES (${randomUUID()}, ${account.id}, ${eventType.id}, ${member.id}, ${args.startMs},
          ${endMs}, ${uid}, ${releaseAtMs}, 0, ${now})`,
  );
  return { uid, releaseAtMs };
}

// --- Identity / multi-tenant ----------------------------------------------

export interface MeView {
  accountId: string;
  accountCode: string;
  memberId: string;
  handle: string | null;
  displayName: string | null;
  email: string | null;
}

/** Resolve the authenticated principal's account + member for /me. */
export async function getMe(
  db: Db,
  accountId: string,
  memberId?: string,
): Promise<MeView | null> {
  const account = await db.get<{ id: string; code: string }>(
    sql`SELECT id, code FROM account WHERE id = ${accountId} LIMIT 1`,
  );
  if (!account) return null;
  const member = await db.get<{
    id: string;
    handle: string | null;
    display_name: string | null;
    email: string | null;
  }>(
    memberId
      ? sql`SELECT id, handle, display_name, email FROM member WHERE id = ${memberId} AND account_id = ${accountId} LIMIT 1`
      : sql`SELECT id, handle, display_name, email FROM member WHERE account_id = ${accountId} ORDER BY created_at ASC LIMIT 1`,
  );
  if (!member) return null;
  return {
    accountId: account.id,
    accountCode: account.code,
    memberId: member.id,
    handle: member.handle,
    displayName: member.display_name,
    email: member.email,
  };
}

const RESERVED_HANDLES = new Set([
  'team', 'teams', 'api', 'v1', 'public', 'health', 'me', 'login', 'logout', 'signin', 'signup',
  'auth', 'home', 'settings', 'availability', 'event-types', 'events', 'connections', 'admin',
  'app', 'www', 'about', 'help', 'support', 'docs', 'terms', 'privacy', 'pricing', 'demo', 'test',
  'assets', 'favicon', 'robots', 'sitemap', 'calendar', 'calendars', 'null', 'undefined',
]);

export interface HandleAvailability {
  handle: string;
  available: boolean;
  reason: string | null;
}

export async function checkHandleAvailable(
  db: Db,
  accountId: string,
  handle: string,
  excludeMemberId?: string,
): Promise<HandleAvailability> {
  const h = handle.toLowerCase();
  if (h.length < 3) return { handle: h, available: false, reason: 'too_short' };
  if (h.length > 40) return { handle: h, available: false, reason: 'too_long' };
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(h))
    return { handle: h, available: false, reason: 'invalid' };
  if (RESERVED_HANDLES.has(h)) return { handle: h, available: false, reason: 'reserved' };
  const existing = await db.get<{ id: string }>(
    sql`SELECT id FROM member WHERE account_id = ${accountId} AND handle = ${h} LIMIT 1`,
  );
  if (existing && existing.id !== excludeMemberId)
    return { handle: h, available: false, reason: 'taken' };
  return { handle: h, available: true, reason: null };
}

// --- Branding / studio persistence ----------------------------------------

export interface BrandingPatch {
  displayName?: string | null;
  avatarUrl?: string | null;
  coverUrl?: string | null;
  brandColor?: string | null;
  layout?: string | null;
  style?: Record<string, unknown>;
}

export async function updateBranding(
  db: Db,
  memberId: string,
  patch: BrandingPatch,
): Promise<boolean> {
  const sets: ReturnType<typeof sql>[] = [];
  if ('displayName' in patch) sets.push(sql`display_name = ${patch.displayName ?? null}`);
  if ('avatarUrl' in patch) sets.push(sql`avatar_url = ${patch.avatarUrl ?? null}`);
  if ('coverUrl' in patch) sets.push(sql`cover_url = ${patch.coverUrl ?? null}`);
  if ('brandColor' in patch) sets.push(sql`brand_color = ${patch.brandColor ?? null}`);
  if ('layout' in patch) sets.push(sql`layout = ${patch.layout ?? null}`);
  if ('style' in patch) sets.push(sql`booking_page_style = ${jsonParam(db, patch.style ?? null)}`);
  if (sets.length === 0) return true;
  const assignments = sets.reduce((acc, cur, i) => (i === 0 ? cur : sql`${acc}, ${cur}`));
  await db.run(sql`UPDATE member SET ${assignments} WHERE id = ${memberId}`);
  return true;
}

/** Update a member's general settings (timezone, locale, week start). */
export async function updateMemberSettings(
  db: Db,
  memberId: string,
  patch: { timeZone?: string; locale?: string | null; weekStart?: string; displayName?: string | null },
): Promise<void> {
  const sets: ReturnType<typeof sql>[] = [];
  if (patch.timeZone !== undefined) sets.push(sql`time_zone = ${patch.timeZone}`);
  if (patch.locale !== undefined) sets.push(sql`locale = ${patch.locale ?? null}`);
  if (patch.weekStart !== undefined) sets.push(sql`week_start = ${patch.weekStart}`);
  if (patch.displayName !== undefined) sets.push(sql`display_name = ${patch.displayName ?? null}`);
  if (sets.length === 0) return;
  const assign = sets.reduce((a, c, i) => (i === 0 ? c : sql`${a}, ${c}`));
  await db.run(sql`UPDATE member SET ${assign} WHERE id = ${memberId}`);
}

/** Rename a member's public handle (checked available first by the caller). */
export async function updateHandle(db: Db, memberId: string, handle: string): Promise<void> {
  await db.run(sql`UPDATE member SET handle = ${handle} WHERE id = ${memberId}`);
}

// --- Teams ----------------------------------------------------------------

export interface TeamProfileView {
  account: { code: string; name: string };
  team: { slug: string; name: string; logoUrl: string | null; timeZone: string };
  eventTypes: Array<{
    slug: string;
    title: string;
    description: string | null;
    lengthMinutes: number;
    schedulingType: string | null;
  }>;
}

async function getTeamBySlug(db: Db, accountId: string, teamSlug: string) {
  return db.get<{ id: string; slug: string; name: string; logo_url: string | null; time_zone: string }>(
    sql`SELECT id, slug, name, logo_url, time_zone FROM team WHERE account_id = ${accountId} AND slug = ${teamSlug} LIMIT 1`,
  );
}

export async function getTeamProfile(
  db: Db,
  accountCode: string,
  teamSlug: string,
): Promise<TeamProfileView | null> {
  const account = await getAccountByCode(db, accountCode);
  if (!account) return null;
  const team = await getTeamBySlug(db, account.id, teamSlug);
  if (!team) return null;
  const rows = await db.all<{
    slug: string;
    title: string;
    description: string | null;
    length_minutes: number;
    scheduling_type: string | null;
  }>(
    sql`SELECT slug, title, description, length_minutes, scheduling_type FROM event_type
        WHERE account_id = ${account.id} AND team_id = ${team.id} AND hidden = 0
        ORDER BY length_minutes ASC`,
  );
  return {
    account: { code: account.code, name: account.name },
    team: { slug: team.slug, name: team.name, logoUrl: team.logo_url, timeZone: team.time_zone },
    eventTypes: rows.map((r) => ({
      slug: r.slug,
      title: r.title,
      description: r.description,
      lengthMinutes: r.length_minutes,
      schedulingType: r.scheduling_type,
    })),
  };
}

interface TeamEventType {
  id: string;
  account_id: string;
  team_id: string;
  slug: string;
  title: string;
  length_minutes: number;
  slot_interval: number | null;
  minimum_booking_notice: number;
  before_event_buffer: number;
  after_event_buffer: number;
  scheduling_type: string | null;
  booking_fields: unknown;
}

async function getTeamEventType(db: Db, accountId: string, teamId: string, slug: string) {
  return db.get<TeamEventType>(
    sql`SELECT id, account_id, team_id, slug, title, length_minutes, slot_interval,
               minimum_booking_notice, before_event_buffer, after_event_buffer, scheduling_type,
               booking_fields
        FROM event_type
        WHERE account_id = ${accountId} AND team_id = ${teamId} AND slug = ${slug} AND hidden = 0
        LIMIT 1`,
  );
}

interface EventHostRow {
  member_id: string;
  is_fixed: number;
  priority: number | null;
  weight: number | null;
  schedule_id: string | null;
}

async function getEventHosts(db: Db, eventTypeId: string): Promise<EventHostRow[]> {
  return db.all<EventHostRow>(
    sql`SELECT member_id, is_fixed, priority, weight, schedule_id FROM event_type_host
        WHERE event_type_id = ${eventTypeId}`,
  );
}

/** Free slot instants (ms) for one host of a team event, over the window. */
async function hostFreeSlotMs(
  db: Db,
  host: EventHostRow,
  et: TeamEventType,
  fromMs: number,
  toMs: number,
  now: Date,
): Promise<Set<number>> {
  const member = await db.get<{ time_zone: string; default_schedule_id: string | null }>(
    sql`SELECT time_zone, default_schedule_id FROM member WHERE id = ${host.member_id} LIMIT 1`,
  );
  if (!member) return new Set();
  const schedule =
    (await resolveScheduleTimeZone(db, host.schedule_id)) ??
    (await resolveScheduleTimeZone(db, member.default_schedule_id));
  const tz = schedule?.timeZone ?? member.time_zone;
  let rules: AvailabilityRule[] = [];
  if (schedule) rules = await loadAvailabilityRules(db, schedule.id);
  const busy: Interval[] = [
    ...(await loadBusyForHost(db, host.member_id, fromMs, toMs)),
    ...(await loadReservationBusy(db, host.member_id, fromMs, toMs, now.getTime())),
  ];
  const slots = computeSlots({
    fromUtc: new Date(fromMs),
    toUtc: new Date(toMs),
    timeZone: tz,
    availability: rules,
    durationMin: et.length_minutes,
    slotIntervalMin: et.slot_interval,
    busy,
    beforeBufferMin: et.before_event_buffer,
    afterBufferMin: et.after_event_buffer,
    minimumBookingNoticeMin: et.minimum_booking_notice,
    now,
  });
  return new Set(slots.map((d) => d.getTime()));
}

export interface TeamAvailabilityResult {
  eventType: { slug: string; title: string; lengthMinutes: number; bookingFields: BookingFieldDef[] };
  timeZone: string;
  slots: string[];
}

/**
 * Team availability = the UNION of every host's free slots (a slot is offered
 * if AT LEAST ONE host is free). The specific host is chosen at booking time.
 */
export async function getTeamAvailability(
  db: Db,
  args: {
    accountCode: string;
    teamSlug: string;
    slug: string;
    fromMs: number;
    toMs: number;
    displayTimeZone?: string;
    now?: Date;
  },
): Promise<TeamAvailabilityResult | null> {
  const account = await getAccountByCode(db, args.accountCode);
  if (!account) return null;
  const team = await getTeamBySlug(db, account.id, args.teamSlug);
  if (!team) return null;
  const et = await getTeamEventType(db, account.id, team.id, args.slug);
  if (!et) return null;
  const hosts = await getEventHosts(db, et.id);
  const now = args.now ?? new Date();

  const union = new Set<number>();
  for (const host of hosts) {
    const free = await hostFreeSlotMs(db, host, et, args.fromMs, args.toMs, now);
    for (const ms of free) union.add(ms);
  }
  const slots = [...union].sort((a, b) => a - b).map((ms) => new Date(ms).toISOString());
  return {
    eventType: {
      slug: et.slug,
      title: et.title,
      lengthMinutes: et.length_minutes,
      bookingFields: parseJsonColumn<BookingFieldDef[]>(et.booking_fields, []),
    },
    timeZone: args.displayTimeZone ?? team.time_zone,
    slots,
  };
}

export type TeamBookingOutcome =
  | { ok: true; uid: string; hostMemberId: string; manageToken: string }
  | { ok: false; reason: 'NOT_FOUND' | 'SLOT_TAKEN' | 'INVALID'; message?: string };

/**
 * Book a team event: among the hosts FREE at the chosen slot, pick the fair one
 * (round-robin via the engine's selectLuckyHost), then insert with the same
 * dual-enforced overlap guard used for personal bookings.
 */
export async function createTeamBooking(
  db: Db,
  args: {
    accountCode: string;
    teamSlug: string;
    slug: string;
    startMs: number;
    attendee: { name: string; email: string; timeZone: string; notes?: string; phone?: string };
    answers?: Record<string, unknown>;
  },
): Promise<TeamBookingOutcome> {
  const account = await getAccountByCode(db, args.accountCode);
  if (!account) return { ok: false, reason: 'NOT_FOUND' };
  const team = await getTeamBySlug(db, account.id, args.teamSlug);
  if (!team) return { ok: false, reason: 'NOT_FOUND' };
  const et = await getTeamEventType(db, account.id, team.id, args.slug);
  if (!et) return { ok: false, reason: 'NOT_FOUND' };

  const invalid = validateTeamIntake(et, args.answers);
  if (invalid) return { ok: false, reason: 'INVALID', message: invalid };

  const endMs = args.startMs + et.length_minutes * 60_000;
  const hosts = await getEventHosts(db, et.id);

  // Which hosts are actually free at this instant?
  const candidates: (HostCandidate & { row: EventHostRow })[] = [];
  for (const host of hosts) {
    const conflict = await db.get<{ id: string }>(
      sql`SELECT id FROM booking WHERE host_member_id = ${host.member_id} AND status = 'accepted'
          AND start_ms < ${endMs} AND end_ms > ${args.startMs} LIMIT 1`,
    );
    if (conflict) continue;
    const counts = await db.get<{ n: number; last: number | null }>(
      sql`SELECT COUNT(*) AS n, MAX(start_ms) AS last FROM booking
          WHERE host_member_id = ${host.member_id} AND status = 'accepted'`,
    );
    candidates.push({
      memberId: host.member_id,
      priority: host.priority,
      weight: host.weight,
      bookingCount: Number(counts?.n ?? 0),
      lastBookedAt: counts?.last ? new Date(Number(counts.last)) : null,
      row: host,
    });
  }
  const lucky = selectLuckyHost(candidates);
  if (!lucky) return { ok: false, reason: 'SLOT_TAKEN' };

  const uid = randomUUID();
  const bookingId = randomUUID();
  const attendeeId = randomUUID();
  const now = Date.now();
  const { token, tokenHash } = generateManageToken();
  const metaExpr = jsonParam(db, { _manage: { tokenHash } });
  const responsesExpr = jsonParam(db, args.answers ?? null);

  const insertBooking = sql`
    INSERT INTO booking (id, account_id, uid, event_type_id, host_member_id, team_id, title,
      start_ms, end_ms, status, metadata, responses, attendee_time_zone, created_at, updated_at)
    VALUES (${bookingId}, ${account.id}, ${uid}, ${et.id}, ${lucky.memberId}, ${team.id}, ${et.title},
      ${args.startMs}, ${endMs}, 'accepted', ${metaExpr}, ${responsesExpr}, ${args.attendee.timeZone},
      ${now}, ${now})`;
  const insertAttendee = sql`
    INSERT INTO booking_attendee (id, booking_id, name, email, time_zone, phone, notes, created_at)
    VALUES (${attendeeId}, ${bookingId}, ${args.attendee.name}, ${args.attendee.email},
      ${args.attendee.timeZone}, ${args.attendee.phone ?? null}, ${args.attendee.notes ?? null}, ${now})`;

  const booked = await insertBookingGuarded(db, lucky.memberId, args.startMs, endMs, insertBooking, insertAttendee);
  return booked
    ? { ok: true, uid, hostMemberId: lucky.memberId, manageToken: token }
    : { ok: false, reason: 'SLOT_TAKEN' };
}

function validateTeamIntake(et: TeamEventType, answers?: Record<string, unknown>): string | null {
  const fields = parseJsonColumn<BookingFieldDef[]>(et.booking_fields, []);
  for (const f of fields) {
    if (!f.required) continue;
    const v = answers?.[f.name];
    if (v == null || v === '' || (Array.isArray(v) && v.length === 0) || v === false)
      return `Missing required field: ${f.label}`;
  }
  return null;
}

/** Shared dual-enforced insert (SQLite sync txn / Postgres async txn + EXCLUDE). */
async function insertBookingGuarded(
  db: Db,
  hostMemberId: string,
  startMs: number,
  endMs: number,
  insertBooking: ReturnType<typeof sql>,
  insertAttendee: ReturnType<typeof sql>,
): Promise<boolean> {
  const overlapSql = sql`SELECT id FROM booking WHERE host_member_id = ${hostMemberId}
    AND status = 'accepted' AND start_ms < ${endMs} AND end_ms > ${startMs} LIMIT 1`;
  if (db.dialect === 'sqlite') {
    return db.sqlite!.txn<boolean>(() => {
      if (db.sqlite!.drizzle.get(overlapSql)) return false;
      db.sqlite!.drizzle.run(insertBooking);
      db.sqlite!.drizzle.run(insertAttendee);
      return true;
    });
  }
  const pg = db.pg!.drizzle;
  try {
    return await pg.transaction(async (tx) => {
      const rows = (await tx.execute(overlapSql)) as unknown as unknown[];
      if (rows.length > 0) return false;
      await tx.execute(insertBooking);
      await tx.execute(insertAttendee);
      return true;
    });
  } catch {
    return false;
  }
}

// --- Reschedule / cancel --------------------------------------------------

interface BookingRow {
  id: string;
  account_id: string;
  uid: string;
  event_type_id: string | null;
  host_member_id: string | null;
  title: string;
  start_ms: number;
  end_ms: number;
  status: string;
  metadata: unknown;
}

/**
 * Resolve a booking by uid. When `accountId` is provided (every host/admin
 * path), the lookup is tenant-scoped: a booking in another account resolves to
 * `undefined` (→ NOT_FOUND), never leaking its existence or letting it be
 * mutated. The public manage path (uid + manage token) passes no accountId.
 */
export async function resolveBooking(
  db: Db,
  uid: string,
  accountId?: string,
): Promise<BookingRow | undefined> {
  const scope = accountId != null ? sql` AND account_id = ${accountId}` : sql``;
  return db.get<BookingRow>(
    sql`SELECT id, account_id, uid, event_type_id, host_member_id, title, start_ms, end_ms, status, metadata
        FROM booking WHERE uid = ${uid}${scope} LIMIT 1`,
  );
}

function manageHashOf(metadata: unknown): string | null {
  const meta = parseJsonColumn<{ _manage?: { tokenHash?: string } }>(metadata, {});
  return meta._manage?.tokenHash ?? null;
}

export type MutationOutcome =
  | { ok: true; uid: string; startUtc: string; endUtc: string; manageToken?: string }
  | { ok: false; reason: 'NOT_FOUND' | 'FORBIDDEN' | 'SLOT_TAKEN' | 'GONE' };

export async function rescheduleBooking(
  db: Db,
  args: { uid: string; newStartMs: number; manageToken?: string; byHost?: boolean; accountId?: string },
): Promise<MutationOutcome> {
  const b = await resolveBooking(db, args.uid, args.accountId);
  if (!b) return { ok: false, reason: 'NOT_FOUND' };
  if (b.status !== 'accepted') return { ok: false, reason: 'GONE' };
  if (!args.byHost && !verifyManageToken(args.manageToken ?? '', manageHashOf(b.metadata)))
    return { ok: false, reason: 'FORBIDDEN' };

  const duration = Number(b.end_ms) - Number(b.start_ms);
  const newEndMs = args.newStartMs + duration;
  const now = Date.now();
  const { token, tokenHash } = generateManageToken();
  const metaExpr = jsonParam(db, { _manage: { tokenHash } });

  const overlapSql = sql`SELECT id FROM booking WHERE host_member_id = ${b.host_member_id}
    AND status = 'accepted' AND id <> ${b.id}
    AND start_ms < ${newEndMs} AND end_ms > ${args.newStartMs} LIMIT 1`;
  const updateSql = sql`UPDATE booking SET start_ms = ${args.newStartMs}, end_ms = ${newEndMs},
    rescheduled = 1, metadata = ${metaExpr}, updated_at = ${now} WHERE id = ${b.id}`;

  const moved = await runGuardedUpdate(db, overlapSql, updateSql);
  if (!moved) return { ok: false, reason: 'SLOT_TAKEN' };
  return {
    ok: true,
    uid: b.uid,
    startUtc: new Date(args.newStartMs).toISOString(),
    endUtc: new Date(newEndMs).toISOString(),
    manageToken: token,
  };
}

async function runGuardedUpdate(
  db: Db,
  overlapSql: ReturnType<typeof sql>,
  updateSql: ReturnType<typeof sql>,
): Promise<boolean> {
  if (db.dialect === 'sqlite') {
    return db.sqlite!.txn<boolean>(() => {
      if (db.sqlite!.drizzle.get(overlapSql)) return false;
      db.sqlite!.drizzle.run(updateSql);
      return true;
    });
  }
  const pg = db.pg!.drizzle;
  try {
    return await pg.transaction(async (tx) => {
      const rows = (await tx.execute(overlapSql)) as unknown as unknown[];
      if (rows.length > 0) return false;
      await tx.execute(updateSql);
      return true;
    });
  } catch {
    return false;
  }
}

export async function cancelBooking(
  db: Db,
  args: { uid: string; reason?: string; manageToken?: string; byHost?: boolean; accountId?: string },
): Promise<MutationOutcome> {
  const b = await resolveBooking(db, args.uid, args.accountId);
  if (!b) return { ok: false, reason: 'NOT_FOUND' };
  if (b.status !== 'accepted') return { ok: false, reason: 'GONE' };
  if (!args.byHost && !verifyManageToken(args.manageToken ?? '', manageHashOf(b.metadata)))
    return { ok: false, reason: 'FORBIDDEN' };
  const now = Date.now();
  await db.run(
    sql`UPDATE booking SET status = 'cancelled', cancellation_reason = ${args.reason ?? null},
        cancelled_by = ${args.byHost ? 'host' : 'attendee'}, updated_at = ${now} WHERE id = ${b.id}`,
  );
  return {
    ok: true,
    uid: b.uid,
    startUtc: new Date(Number(b.start_ms)).toISOString(),
    endUtc: new Date(Number(b.end_ms)).toISOString(),
  };
}

/** Host confirms a pending booking → accepted (guarded by overlap + EXCLUDE). */
export async function confirmBooking(
  db: Db,
  uid: string,
  accountId?: string,
): Promise<MutationOutcome> {
  const b = await resolveBooking(db, uid, accountId);
  if (!b) return { ok: false, reason: 'NOT_FOUND' };
  if (b.status !== 'pending') return { ok: false, reason: 'GONE' };
  const now = Date.now();
  const overlapSql = sql`SELECT id FROM booking WHERE host_member_id = ${b.host_member_id}
    AND status = 'accepted' AND id <> ${b.id}
    AND start_ms < ${b.end_ms} AND end_ms > ${b.start_ms} LIMIT 1`;
  const updateSql = sql`UPDATE booking SET status = 'accepted', updated_at = ${now} WHERE id = ${b.id}`;
  const ok = await runGuardedUpdate(db, overlapSql, updateSql);
  if (!ok) return { ok: false, reason: 'SLOT_TAKEN' };
  return {
    ok: true,
    uid: b.uid,
    startUtc: new Date(Number(b.start_ms)).toISOString(),
    endUtc: new Date(Number(b.end_ms)).toISOString(),
  };
}

/** Host declines a pending booking → rejected (releases the held slot). */
export async function declineBooking(
  db: Db,
  uid: string,
  reason?: string,
  accountId?: string,
): Promise<MutationOutcome> {
  const b = await resolveBooking(db, uid, accountId);
  if (!b) return { ok: false, reason: 'NOT_FOUND' };
  if (b.status !== 'pending') return { ok: false, reason: 'GONE' };
  await db.run(
    sql`UPDATE booking SET status = 'rejected', cancellation_reason = ${reason ?? null},
        updated_at = ${Date.now()} WHERE id = ${b.id}`,
  );
  return {
    ok: true,
    uid: b.uid,
    startUtc: new Date(Number(b.start_ms)).toISOString(),
    endUtc: new Date(Number(b.end_ms)).toISOString(),
  };
}

// --- Host bookings list ---------------------------------------------------

export interface BookingListItem {
  uid: string;
  status: string;
  title: string;
  startUtc: string;
  endUtc: string;
  hostMemberId: string | null;
}

export async function listBookings(
  db: Db,
  args: {
    accountId: string;
    memberId?: string;
    from?: number;
    to?: number;
    status?: string;
    limit?: number;
  },
): Promise<{ items: BookingListItem[] }> {
  const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
  const conds = [sql`account_id = ${args.accountId}`];
  if (args.memberId) conds.push(sql`host_member_id = ${args.memberId}`);
  if (args.from != null) conds.push(sql`start_ms >= ${args.from}`);
  if (args.to != null) conds.push(sql`start_ms < ${args.to}`);
  if (args.status) conds.push(sql`status = ${args.status}`);
  const where = conds.reduce((acc, cur, i) => (i === 0 ? cur : sql`${acc} AND ${cur}`));
  const rows = await db.all<{
    uid: string;
    status: string;
    title: string;
    start_ms: number;
    end_ms: number;
    host_member_id: string | null;
  }>(
    sql`SELECT uid, status, title, start_ms, end_ms, host_member_id FROM booking
        WHERE ${where} ORDER BY start_ms DESC LIMIT ${limit}`,
  );
  return {
    items: rows.map((r) => ({
      uid: r.uid,
      status: r.status,
      title: r.title,
      startUtc: new Date(Number(r.start_ms)).toISOString(),
      endUtc: new Date(Number(r.end_ms)).toISOString(),
      hostMemberId: r.host_member_id,
    })),
  };
}

// --- Connections (behind the CalendarProvider port — generic, no vendor) --

export interface ConnectionView {
  id: string;
  provider: string;
  externalId: string;
  primaryEmail: string | null;
  isDestination: boolean;
  checkConflicts: boolean;
}

export async function listConnections(db: Db, memberId: string): Promise<ConnectionView[]> {
  const rows = await db.all<{
    id: string;
    provider: string;
    external_id: string;
    primary_email: string | null;
    is_destination: number;
    check_conflicts: number;
  }>(
    sql`SELECT id, provider, external_id, primary_email, is_destination, check_conflicts
        FROM connected_calendar WHERE member_id = ${memberId}`,
  );
  return rows.map((r) => ({
    id: r.id,
    provider: r.provider,
    externalId: r.external_id,
    primaryEmail: r.primary_email,
    isDestination: !!r.is_destination,
    checkConflicts: !!r.check_conflicts,
  }));
}

export async function createConnection(
  db: Db,
  args: {
    accountId: string;
    memberId: string;
    provider: string;
    externalId: string;
    primaryEmail?: string;
    isDestination?: boolean;
    checkConflicts?: boolean;
  },
): Promise<{ id: string }> {
  const id = randomUUID();
  await db.run(
    sql`INSERT INTO connected_calendar (id, account_id, member_id, provider, external_id,
          primary_email, is_destination, check_conflicts, created_at)
        VALUES (${id}, ${args.accountId}, ${args.memberId}, ${args.provider}, ${args.externalId},
          ${args.primaryEmail ?? null}, ${args.isDestination ? 1 : 0},
          ${args.checkConflicts === false ? 0 : 1}, ${Date.now()})`,
  );
  return { id };
}

export async function deleteConnection(db: Db, memberId: string, id: string): Promise<void> {
  await db.run(
    sql`DELETE FROM connected_calendar WHERE id = ${id} AND member_id = ${memberId}`,
  );
}

// --- API keys -------------------------------------------------------------

export interface CreatedApiKey {
  id: string;
  name: string;
  prefix: string;
  last4: string;
  plaintext: string;
  scopes: string[];
}

export async function createApiKey(
  db: Db,
  args: { accountId: string; name: string; scopes: string[]; eventTypeIds?: string[]; expiresAtMs?: number },
): Promise<CreatedApiKey> {
  const id = randomUUID();
  const secret = randomBytes(24).toString('base64url');
  const prefix = `slk_${randomBytes(4).toString('hex')}`;
  const plaintext = `${prefix}_${secret}`;
  const keyHash = createHash('sha256').update(plaintext).digest('hex');
  const last4 = plaintext.slice(-4);
  await db.run(
    sql`INSERT INTO api_key (id, account_id, name, prefix, last4, key_hash, scopes, event_type_ids,
          expires_at_ms, created_at)
        VALUES (${id}, ${args.accountId}, ${args.name}, ${prefix}, ${last4}, ${keyHash},
          ${jsonParam(db, args.scopes)}, ${jsonParam(db, args.eventTypeIds ?? null)},
          ${args.expiresAtMs ?? null}, ${Date.now()})`,
  );
  return { id, name: args.name, prefix, last4, plaintext, scopes: args.scopes };
}

export interface ApiKeyPrincipal {
  accountId: string;
  scopes: string[];
  eventTypeIds: string[] | null;
}

/** Verify a presented plaintext key: hash → lookup → not revoked/expired. */
export async function verifyApiKey(db: Db, plaintext: string): Promise<ApiKeyPrincipal | null> {
  if (!plaintext) return null;
  const keyHash = createHash('sha256').update(plaintext).digest('hex');
  const row = await db.get<{
    id: string;
    account_id: string;
    scopes: unknown;
    event_type_ids: unknown;
    revoked_at_ms: number | null;
    expires_at_ms: number | null;
  }>(
    sql`SELECT id, account_id, scopes, event_type_ids, revoked_at_ms, expires_at_ms
        FROM api_key WHERE key_hash = ${keyHash} LIMIT 1`,
  );
  if (!row) return null;
  const now = Date.now();
  if (row.revoked_at_ms != null) return null;
  if (row.expires_at_ms != null && Number(row.expires_at_ms) <= now) return null;
  await db.run(sql`UPDATE api_key SET last_used_at_ms = ${now} WHERE id = ${row.id}`);
  return {
    accountId: row.account_id,
    scopes: parseJsonColumn<string[]>(row.scopes, []),
    eventTypeIds: parseJsonColumn<string[] | null>(row.event_type_ids, null),
  };
}

export async function listApiKeys(db: Db, accountId: string) {
  return db.all<{ id: string; name: string; prefix: string; last4: string; revoked_at_ms: number | null }>(
    sql`SELECT id, name, prefix, last4, revoked_at_ms FROM api_key WHERE account_id = ${accountId}
        ORDER BY created_at DESC`,
  );
}

export async function revokeApiKey(db: Db, accountId: string, id: string): Promise<void> {
  await db.run(
    sql`UPDATE api_key SET revoked_at_ms = ${Date.now()} WHERE id = ${id} AND account_id = ${accountId}`,
  );
}

// --- Webhooks -------------------------------------------------------------

export async function listWebhooks(db: Db, accountId: string) {
  return db.all<{
    id: string;
    subscriber_url: string;
    event_triggers: unknown;
    active: number;
  }>(
    sql`SELECT id, subscriber_url, event_triggers, active FROM webhook WHERE account_id = ${accountId}`,
  );
}

export async function createWebhook(
  db: Db,
  args: {
    accountId: string;
    subscriberUrl: string;
    eventTriggers: string[];
    secret?: string;
    memberId?: string;
    teamId?: string;
    eventTypeId?: string;
  },
): Promise<{ id: string }> {
  const id = randomUUID();
  await db.run(
    sql`INSERT INTO webhook (id, account_id, member_id, team_id, event_type_id, subscriber_url,
          secret, event_triggers, active, created_at)
        VALUES (${id}, ${args.accountId}, ${args.memberId ?? null}, ${args.teamId ?? null},
          ${args.eventTypeId ?? null}, ${args.subscriberUrl}, ${args.secret ?? null},
          ${jsonParam(db, args.eventTriggers)}, 1, ${Date.now()})`,
  );
  return { id };
}

export async function deleteWebhook(db: Db, accountId: string, id: string): Promise<void> {
  await db.run(sql`DELETE FROM webhook WHERE id = ${id} AND account_id = ${accountId}`);
}

/**
 * Fire matching webhooks for a lifecycle event (best-effort, fire-and-forget).
 * Each dispatch signs the JSON body with HMAC-SHA256 over the webhook's secret
 * and sends it as `X-Slate-Signature: sha256=<hex>` (D17). One dispatch per
 * subscription per event. Never throws — a failed webhook must not affect the
 * booking. `fetchImpl` is injectable for tests.
 */
export async function dispatchWebhooks(
  db: Db,
  accountId: string,
  event: string,
  payload: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const hooks = await db.all<{
    id: string;
    subscriber_url: string;
    secret: string | null;
    event_triggers: unknown;
    active: number;
  }>(
    sql`SELECT id, subscriber_url, secret, event_triggers, active FROM webhook
        WHERE account_id = ${accountId} AND active = 1`,
  );
  const body = JSON.stringify({ event, data: payload });
  let sent = 0;
  await Promise.all(
    hooks.map(async (h) => {
      const triggers = parseJsonColumn<string[]>(h.event_triggers, []);
      if (!triggers.includes(event)) return;
      const headers: Record<string, string> = { 'content-type': 'application/json', 'X-Slate-Event': event };
      if (h.secret) {
        headers['X-Slate-Signature'] = `sha256=${createHmac('sha256', h.secret).update(body).digest('hex')}`;
      }
      try {
        await fetchImpl(h.subscriber_url, { method: 'POST', headers, body });
        sent++;
      } catch {
        /* best-effort — swallow */
      }
    }),
  );
  return sent;
}
