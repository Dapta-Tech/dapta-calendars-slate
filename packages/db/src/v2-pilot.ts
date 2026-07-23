import { createHash, randomUUID } from 'node:crypto';
import type { CalendarProvider } from '@slate/calendar';
import { generateManageToken } from '@slate/engine';
import type { Db } from './client';
import { sql } from './client';
import { loadExternalBusy } from './calendar-refs';
import { bookingStartOutOfRange, isSlotBookable, jsonParam, parseJsonColumn } from './repository';

export interface CalendarConnectionRow {
  id: string;
  accountId: string;
  memberId: string;
  provider: string;
  connectionRef: string;
  primaryEmail: string | null;
  isDestination: boolean;
  checkConflicts: boolean;
}

export interface ProviderCalendarRow {
  id: string;
  accountId: string;
  memberId: string;
  connectedCalendarId: string;
  provider: string;
  connectionRef: string;
  credentialId: string;
  externalId: string;
  name: string;
  email: string | null;
  primary: boolean;
  readOnly: boolean;
  isSelected: boolean;
  isDestination: boolean;
  accessRole: 'owner' | 'writer' | 'reader' | 'freeBusyReader' | 'none';
  source: 'primary' | 'owned' | 'shared' | 'subscribed' | 'delegated';
  capabilities: {
    canRead: boolean;
    canReadFreeBusy: boolean;
    canCreate: boolean;
    canUpdate: boolean;
    canDelete: boolean;
  };
  syncStatus: 'healthy' | 'stale' | 'error';
  lastSyncedAt: number | null;
}

export async function listCalendarConnections(db: Db, accountId: string): Promise<CalendarConnectionRow[]> {
  const rows = await db.all<{
    id: string;
    account_id: string;
    member_id: string;
    provider: string;
    external_id: string;
    primary_email: string | null;
    is_destination: number;
    check_conflicts: number;
  }>(
    sql`SELECT id, account_id, member_id, provider, external_id, primary_email,
               is_destination, check_conflicts
        FROM connected_calendar
        WHERE account_id = ${accountId}
        ORDER BY created_at ASC, id ASC`,
  );
  return rows.map((row) => ({
    id: row.id,
    accountId: row.account_id,
    memberId: row.member_id,
    provider: row.provider,
    connectionRef: row.external_id,
    primaryEmail: row.primary_email,
    isDestination: row.is_destination === 1,
    checkConflicts: row.check_conflicts === 1,
  }));
}

interface UpsertProviderCalendarInput {
  connection: CalendarConnectionRow;
  externalId: string;
  name: string;
  email?: string | null;
  primary: boolean;
  readOnly: boolean;
  accessRole: ProviderCalendarRow['accessRole'];
  source: ProviderCalendarRow['source'];
  capabilities: ProviderCalendarRow['capabilities'];
  now?: number;
}

export async function upsertProviderCalendar(
  db: Db,
  input: UpsertProviderCalendarInput,
): Promise<ProviderCalendarRow> {
  const now = input.now ?? Date.now();
  const id = `cal_${randomUUID().replaceAll('-', '')}`;
  await db.run(
    sql`INSERT INTO provider_calendar
          (id, account_id, member_id, connected_calendar_id, external_id, name, email,
           is_primary, read_only, access_role, source, can_read, can_read_free_busy,
           can_create, can_update, can_delete, sync_status, last_synced_at, created_at, updated_at)
        VALUES (${id}, ${input.connection.accountId}, ${input.connection.memberId},
          ${input.connection.id}, ${input.externalId}, ${input.name}, ${input.email ?? null},
          ${input.primary ? 1 : 0}, ${input.readOnly ? 1 : 0}, ${input.accessRole}, ${input.source},
          ${input.capabilities.canRead ? 1 : 0}, ${input.capabilities.canReadFreeBusy ? 1 : 0},
          ${input.capabilities.canCreate ? 1 : 0}, ${input.capabilities.canUpdate ? 1 : 0},
          ${input.capabilities.canDelete ? 1 : 0}, 'healthy', ${now}, ${now}, ${now})
        ON CONFLICT (connected_calendar_id, external_id) DO UPDATE SET
          name = excluded.name,
          email = excluded.email,
          is_primary = excluded.is_primary,
          read_only = excluded.read_only,
          access_role = excluded.access_role,
          source = excluded.source,
          can_read = excluded.can_read,
          can_read_free_busy = excluded.can_read_free_busy,
          can_create = excluded.can_create,
          can_update = excluded.can_update,
          can_delete = excluded.can_delete,
          sync_status = 'healthy',
          last_synced_at = excluded.last_synced_at,
          updated_at = excluded.updated_at`,
  );
  const row = await getProviderCalendarByIdentity(
    db,
    input.connection.accountId,
    input.connection.id,
    input.externalId,
  );
  if (!row) throw new Error('provider calendar upsert did not persist');
  return row;
}

export async function markProviderCalendarSyncError(
  db: Db,
  accountId: string,
  connectedCalendarId: string,
): Promise<void> {
  await db.run(
    sql`UPDATE provider_calendar
        SET sync_status = 'error', updated_at = ${Date.now()}
        WHERE account_id = ${accountId} AND connected_calendar_id = ${connectedCalendarId}`,
  );
}

function mapProviderCalendar(row: {
  id: string;
  account_id: string;
  member_id: string;
  connected_calendar_id: string;
  provider: string;
  connection_ref: string;
  external_id: string;
  name: string;
  email: string | null;
  is_primary: number;
  read_only: number;
  check_conflicts: number;
  is_destination: number;
  access_role: ProviderCalendarRow['accessRole'];
  source: ProviderCalendarRow['source'];
  can_read: number;
  can_read_free_busy: number;
  can_create: number;
  can_update: number;
  can_delete: number;
  sync_status: ProviderCalendarRow['syncStatus'];
  last_synced_at: number | null;
}): ProviderCalendarRow {
  return {
    id: row.id,
    accountId: row.account_id,
    memberId: row.member_id,
    connectedCalendarId: row.connected_calendar_id,
    provider: row.provider,
    connectionRef: row.connection_ref,
    credentialId: row.connected_calendar_id,
    externalId: row.external_id,
    name: row.name,
    email: row.email,
    primary: row.is_primary === 1,
    readOnly: row.read_only === 1,
    isSelected: row.check_conflicts === 1,
    isDestination: row.is_destination === 1 && row.is_primary === 1,
    accessRole: row.access_role,
    source: row.source,
    capabilities: {
      canRead: row.can_read === 1,
      canReadFreeBusy: row.can_read_free_busy === 1,
      canCreate: row.can_create === 1,
      canUpdate: row.can_update === 1,
      canDelete: row.can_delete === 1,
    },
    syncStatus: row.sync_status,
    lastSyncedAt: row.last_synced_at == null ? null : Number(row.last_synced_at),
  };
}

const providerCalendarSelect = sql`
  SELECT pc.id, pc.account_id, pc.member_id, pc.connected_calendar_id,
         cc.provider, cc.external_id AS connection_ref, pc.external_id, pc.name, pc.email,
         pc.is_primary, pc.read_only, cc.check_conflicts, cc.is_destination,
         pc.access_role, pc.source, pc.can_read, pc.can_read_free_busy,
         pc.can_create, pc.can_update, pc.can_delete, pc.sync_status, pc.last_synced_at
  FROM provider_calendar pc
  JOIN connected_calendar cc ON cc.id = pc.connected_calendar_id`;

export async function listProviderCalendars(
  db: Db,
  accountId: string,
  connectedCalendarId?: string,
): Promise<ProviderCalendarRow[]> {
  const connectionScope = connectedCalendarId
    ? sql` AND pc.connected_calendar_id = ${connectedCalendarId}`
    : sql``;
  const rows = await db.all<Parameters<typeof mapProviderCalendar>[0]>(
    sql`${providerCalendarSelect}
        WHERE pc.account_id = ${accountId}${connectionScope}
        ORDER BY pc.created_at ASC, pc.id ASC`,
  );
  return rows.map(mapProviderCalendar);
}

export async function getProviderCalendar(
  db: Db,
  accountId: string,
  id: string,
): Promise<ProviderCalendarRow | undefined> {
  const row = await db.get<Parameters<typeof mapProviderCalendar>[0]>(
    sql`${providerCalendarSelect}
        WHERE pc.account_id = ${accountId} AND pc.id = ${id} LIMIT 1`,
  );
  return row ? mapProviderCalendar(row) : undefined;
}

async function getProviderCalendarByIdentity(
  db: Db,
  accountId: string,
  connectedCalendarId: string,
  externalId: string,
): Promise<ProviderCalendarRow | undefined> {
  const row = await db.get<Parameters<typeof mapProviderCalendar>[0]>(
    sql`${providerCalendarSelect}
        WHERE pc.account_id = ${accountId}
          AND pc.connected_calendar_id = ${connectedCalendarId}
          AND pc.external_id = ${externalId}
        LIMIT 1`,
  );
  return row ? mapProviderCalendar(row) : undefined;
}

export interface ApiIdempotencyRecord {
  id: string;
  requestHash: string;
  statusCode: number | null;
  responseBody: unknown;
}

export async function claimApiIdempotency(
  db: Db,
  args: {
    namespaceHash: string;
    accountId: string;
    apiKeyId: string;
    method: string;
    path: string;
    requestHash: string;
    now?: number;
  },
): Promise<ApiIdempotencyRecord> {
  const now = args.now ?? Date.now();
  await db.run(sql`DELETE FROM api_idempotency WHERE expires_at <= ${now}`);
  const id = randomUUID();
  await db.run(
    sql`INSERT INTO api_idempotency
          (id, namespace_hash, account_id, api_key_id, method, path, request_hash,
           status_code, response_body, created_at, expires_at)
        VALUES (${id}, ${args.namespaceHash}, ${args.accountId}, ${args.apiKeyId},
          ${args.method}, ${args.path}, ${args.requestHash}, NULL, NULL, ${now},
          ${now + 24 * 60 * 60_000})
        ON CONFLICT (namespace_hash) DO NOTHING`,
  );
  const row = await db.get<{
    id: string;
    request_hash: string;
    status_code: number | null;
    response_body: unknown;
  }>(
    sql`SELECT id, request_hash, status_code, response_body
        FROM api_idempotency WHERE namespace_hash = ${args.namespaceHash} LIMIT 1`,
  );
  if (!row) throw new Error('idempotency claim did not persist');
  return {
    id: row.id,
    requestHash: row.request_hash,
    statusCode: row.status_code == null ? null : Number(row.status_code),
    responseBody: parseJsonColumn(row.response_body, null),
  };
}

export async function completeApiIdempotency(
  db: Db,
  id: string,
  statusCode: number,
  responseBody: unknown,
): Promise<void> {
  await db.run(
    sql`UPDATE api_idempotency
        SET status_code = ${statusCode}, response_body = ${jsonParam(db, responseBody)}
        WHERE id = ${id}`,
  );
}

export async function addGuestsToBooking(
  db: Db,
  args: {
    accountId: string;
    uid: string;
    guests: Array<{ email: string; name?: string; timeZone?: string }>;
  },
): Promise<{ ok: true; added: number } | { ok: false; reason: 'NOT_FOUND' | 'GONE' | 'LIMIT_EXCEEDED' }> {
  const booking = await db.get<{
    id: string;
    status: string;
    metadata: unknown;
  }>(
    sql`SELECT id, status, metadata FROM booking
        WHERE account_id = ${args.accountId} AND uid = ${args.uid} LIMIT 1`,
  );
  if (!booking) return { ok: false, reason: 'NOT_FOUND' };
  if (booking.status !== 'accepted' && booking.status !== 'pending') return { ok: false, reason: 'GONE' };

  const metadata = parseJsonColumn<{ _guests?: string[] }>(booking.metadata, {});
  const existing = new Set((metadata._guests ?? []).map((email) => email.toLowerCase()));
  for (const row of await db.all<{ email: string }>(
    sql`SELECT email FROM booking_attendee WHERE booking_id = ${booking.id}
        UNION ALL
        SELECT email FROM booking_guest WHERE booking_id = ${booking.id}`,
  ))
    existing.add(row.email.toLowerCase());

  const byEmail = new Map<string, (typeof args.guests)[number]>();
  for (const guest of args.guests) {
    const normalized = guest.email.toLowerCase();
    if (!byEmail.has(normalized)) byEmail.set(normalized, guest);
  }
  const unique = [...byEmail.values()].filter((guest) => !existing.has(guest.email.toLowerCase()));
  const totalGuests =
    (metadata._guests ?? []).length +
    Number(
      (
        await db.get<{ count: number }>(
          sql`SELECT COUNT(*) AS count FROM booking_guest WHERE booking_id = ${booking.id}`,
        )
      )?.count ?? 0,
    );
  if (totalGuests + unique.length > 30) return { ok: false, reason: 'LIMIT_EXCEEDED' };

  let added = 0;
  for (const guest of unique) {
    const inserted = await db.get<{ id: string }>(
      sql`INSERT INTO booking_guest
            (id, booking_id, email, email_normalized, name, time_zone, created_at)
          VALUES (${randomUUID()}, ${booking.id}, ${guest.email},
            ${guest.email.toLowerCase()}, ${guest.name ?? null},
            ${guest.timeZone ?? null}, ${Date.now()})
          ON CONFLICT (booking_id, email_normalized) DO NOTHING
          RETURNING id`,
    );
    if (inserted) added += 1;
  }
  return { ok: true, added };
}

interface RescheduleSource {
  id: string;
  account_id: string;
  uid: string;
  event_type_id: string;
  host_member_id: string | null;
  team_id: string | null;
  title: string;
  start_ms: number;
  end_ms: number;
  status: string;
  location: string | null;
  meeting_url: string | null;
  attendee_time_zone: string | null;
  responses: unknown;
  metadata: unknown;
  recurring_event_id: string | null;
}

export type V2RescheduleOutcome =
  | {
      ok: true;
      uid: string;
      status: string;
      previousStartUtc: string;
      manageToken?: string;
      alreadyApplied?: boolean;
    }
  | {
      ok: false;
      reason: 'NOT_FOUND' | 'GONE' | 'INVALID_SLOT' | 'SLOT_TAKEN' | 'CALENDAR_UNAVAILABLE';
    };

export async function rescheduleBookingV2(
  db: Db,
  args: {
    accountId: string;
    uid: string;
    newStartMs: number;
    rescheduledBy?: string;
    reason?: string;
    idempotencyKey?: string;
  },
  calendar?: CalendarProvider,
): Promise<V2RescheduleOutcome> {
  if (args.idempotencyKey) {
    const existing = await db.get<{
      uid: string;
      rescheduled_from_uid: string;
    }>(
      sql`SELECT uid, rescheduled_from_uid FROM booking
          WHERE account_id = ${args.accountId}
            AND idempotency_key = ${args.idempotencyKey}
          LIMIT 1`,
    );
    if (existing)
      return {
        ok: true,
        uid: existing.uid,
        status: 'accepted',
        previousStartUtc: '',
        alreadyApplied: true,
      };
  }

  const source = await db.get<RescheduleSource>(
    sql`SELECT id, account_id, uid, event_type_id, host_member_id, team_id, title,
               start_ms, end_ms, status, location, meeting_url, attendee_time_zone,
               responses, metadata, recurring_event_id
        FROM booking
        WHERE account_id = ${args.accountId} AND uid = ${args.uid} LIMIT 1`,
  );
  if (!source) return { ok: false, reason: 'NOT_FOUND' };
  if (source.status !== 'accepted' && source.status !== 'pending') return { ok: false, reason: 'GONE' };
  if (bookingStartOutOfRange(args.newStartMs)) return { ok: false, reason: 'INVALID_SLOT' };

  const hostRows = await db.all<{ member_id: string }>(
    sql`SELECT member_id FROM booking_host WHERE booking_id = ${source.id}`,
  );
  const hostIds = [
    ...new Set(
      [source.host_member_id, ...hostRows.map((row) => row.member_id)].filter(
        (value): value is string => !!value,
      ),
    ),
  ];
  for (const hostMemberId of hostIds) {
    const bookable = await isSlotBookable(db, {
      eventTypeId: source.event_type_id,
      hostMemberId,
      startMs: args.newStartMs,
      excludeBookingId: source.id,
    });
    if (!bookable) return { ok: false, reason: 'INVALID_SLOT' };
  }

  const duration = Number(source.end_ms) - Number(source.start_ms);
  const newEndMs = args.newStartMs + duration;
  for (const hostMemberId of hostIds) {
    try {
      const busy = await loadExternalBusy(
        db,
        calendar,
        hostMemberId,
        args.newStartMs,
        newEndMs,
        source.event_type_id,
      );
      if (
        busy.some(
          (interval) => interval.start.getTime() < newEndMs && interval.end.getTime() > args.newStartMs,
        )
      )
        return { ok: false, reason: 'SLOT_TAKEN' };
    } catch {
      return { ok: false, reason: 'CALENDAR_UNAVAILABLE' };
    }
  }

  const newId = randomUUID();
  const newUid = randomUUID();
  const now = Date.now();
  const previousStartUtc = new Date(Number(source.start_ms)).toISOString();
  const { token, tokenHash } = generateManageToken();
  const metadata = parseJsonColumn<Record<string, unknown>>(source.metadata, {});
  delete metadata['_idempotency'];
  metadata['_manage'] = { tokenHash };
  const metadataExpr = jsonParam(db, metadata);
  const responsesExpr = jsonParam(
    db,
    parseJsonColumn<Record<string, unknown> | null>(source.responses, null),
  );
  const hostConflictQueries = hostIds.map(
    (hostMemberId) => sql`SELECT b.id FROM booking b
      WHERE b.id <> ${source.id}
        AND b.status IN ('accepted','pending')
        AND b.start_ms < ${newEndMs} AND b.end_ms > ${args.newStartMs}
        AND (b.host_member_id = ${hostMemberId}
          OR EXISTS (
            SELECT 1 FROM booking_host bh
            WHERE bh.booking_id = b.id AND bh.member_id = ${hostMemberId}
          ))
      LIMIT 1`,
  );
  const updateOld = sql`UPDATE booking
    SET status = 'cancelled', rescheduled = 1, rescheduled_to_uid = ${newUid},
        rescheduling_reason = ${args.reason ?? null},
        rescheduled_by_email = ${args.rescheduledBy ?? null},
        cancellation_reason = ${args.reason ?? 'Rescheduled'},
        updated_at = ${now}
    WHERE id = ${source.id}`;
  const insertNew = sql`INSERT INTO booking
    (id, account_id, uid, event_type_id, host_member_id, team_id, title,
     start_ms, end_ms, status, location, meeting_url, attendee_time_zone,
     responses, metadata, cancellation_reason, cancelled_by, rescheduled,
     from_reschedule, rescheduled_from_uid, rescheduled_to_uid,
     rescheduling_reason, rescheduled_by_email, recurring_event_id,
     idempotency_key, created_at, updated_at)
    VALUES (${newId}, ${source.account_id}, ${newUid}, ${source.event_type_id},
      ${source.host_member_id}, ${source.team_id}, ${source.title},
      ${args.newStartMs}, ${newEndMs}, ${source.status}, ${source.location},
      ${source.meeting_url}, ${source.attendee_time_zone}, ${responsesExpr},
      ${metadataExpr}, NULL, NULL, 1, ${previousStartUtc}, ${source.uid}, NULL,
      ${args.reason ?? null}, ${args.rescheduledBy ?? null},
      ${source.recurring_event_id}, ${args.idempotencyKey ?? null}, ${now}, ${now})`;
  const copyAttendees = sql`INSERT INTO booking_attendee
    (id, booking_id, name, email, time_zone, phone, notes, created_at)
    SELECT ${newId} || ':' || id, ${newId}, name, email, time_zone, phone, notes, ${now}
    FROM booking_attendee WHERE booking_id = ${source.id}`;
  const copyGuests = sql`INSERT INTO booking_guest
    (id, booking_id, email, email_normalized, name, time_zone, created_at)
    SELECT ${newId} || ':' || id, ${newId}, email, email_normalized, name, time_zone, ${now}
    FROM booking_guest WHERE booking_id = ${source.id}`;
  const copyHosts = sql`INSERT INTO booking_host
    (id, booking_id, member_id, is_fixed, created_at)
    SELECT ${newId} || ':' || id, ${newId}, member_id, is_fixed, ${now}
    FROM booking_host WHERE booking_id = ${source.id}`;
  const moveReferences = sql`UPDATE booking_reference SET booking_id = ${newId}
    WHERE booking_id = ${source.id}`;
  const repointCalendarJobs = sql`UPDATE outbox SET booking_uid = ${newUid}, updated_at = ${now}
    WHERE booking_uid = ${source.uid} AND kind = 'calendar' AND status = 'pending'`;

  type TxResult = 'ok' | 'gone' | 'conflict';
  let result: TxResult;
  try {
    if (db.dialect === 'sqlite') {
      result = db.sqlite!.txn<TxResult>(() => {
        const current = db.sqlite!.drizzle.get<{ status: string }>(
          sql`SELECT status FROM booking WHERE id = ${source.id} LIMIT 1`,
        );
        if (!current || (current.status !== 'accepted' && current.status !== 'pending')) return 'gone';
        for (const conflict of hostConflictQueries) if (db.sqlite!.drizzle.get(conflict)) return 'conflict';
        for (const statement of [
          updateOld,
          insertNew,
          copyAttendees,
          copyGuests,
          copyHosts,
          moveReferences,
          repointCalendarJobs,
        ])
          db.sqlite!.drizzle.run(statement);
        return 'ok';
      });
    } else {
      result = await db.pg!.drizzle.transaction(async (tx) => {
        const current = (await tx.execute(
          sql`SELECT status FROM booking WHERE id = ${source.id} FOR UPDATE`,
        )) as unknown as Array<{ status: string }>;
        if (!current[0] || (current[0].status !== 'accepted' && current[0].status !== 'pending'))
          return 'gone' as const;
        for (const conflict of hostConflictQueries) {
          const rows = (await tx.execute(conflict)) as unknown as unknown[];
          if (rows.length > 0) return 'conflict' as const;
        }
        for (const statement of [
          updateOld,
          insertNew,
          copyAttendees,
          copyGuests,
          copyHosts,
          moveReferences,
          repointCalendarJobs,
        ])
          await tx.execute(statement);
        return 'ok' as const;
      });
    }
  } catch {
    if (args.idempotencyKey) {
      const existing = await db.get<{ uid: string }>(
        sql`SELECT uid FROM booking
            WHERE account_id = ${args.accountId}
              AND idempotency_key = ${args.idempotencyKey}
            LIMIT 1`,
      );
      if (existing)
        return {
          ok: true,
          uid: existing.uid,
          status: source.status,
          previousStartUtc,
          alreadyApplied: true,
        };
    }
    return { ok: false, reason: 'SLOT_TAKEN' };
  }
  if (result === 'gone') {
    if (args.idempotencyKey) {
      const existing = await db.get<{ uid: string }>(
        sql`SELECT uid FROM booking
            WHERE account_id = ${args.accountId}
              AND idempotency_key = ${args.idempotencyKey}
            LIMIT 1`,
      );
      if (existing)
        return {
          ok: true,
          uid: existing.uid,
          status: source.status,
          previousStartUtc,
          alreadyApplied: true,
        };
    }
    return { ok: false, reason: 'GONE' };
  }
  if (result === 'conflict') return { ok: false, reason: 'SLOT_TAKEN' };
  return {
    ok: true,
    uid: newUid,
    status: source.status,
    previousStartUtc,
    manageToken: token,
  };
}

export function hashApiValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
