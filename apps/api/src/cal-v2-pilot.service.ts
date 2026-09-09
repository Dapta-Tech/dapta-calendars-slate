import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import type { Db, ProviderCalendarRow } from "@slate/db";
import {
  addGuestsToBooking,
  claimApiIdempotency,
  completeApiIdempotency,
  getProviderCalendar,
  hashApiValue,
  listCalendarConnections,
  listProviderCalendars,
  markProviderCalendarSyncError,
  parseJsonColumn,
  rescheduleBookingV2,
  sql,
  upsertProviderCalendar,
} from "@slate/db";
import { parseEventLocation } from "@slate/engine";
import { isValidTimeZone } from "@slate/shared";
import { z } from "zod";
import { BookingService } from "./booking.service";
import { CalendarEffects } from "./calendar-effects";
import { CalV2Service, compatibilityId, v2Error } from "./cal-v2.service";
import { DB } from "./tokens";

const eventTypesQuerySchema = z
  .object({
    username: z.string().min(1).optional(),
    eventSlug: z.string().min(1).optional(),
    teamSlug: z.string().min(1).optional(),
  })
  .strict();

const availabilitySchema = z
  .object({
    calendarIds: z.array(z.string().min(1)).min(1).max(100),
    from: z.string().datetime({ offset: true }),
    to: z.string().datetime({ offset: true }),
    timeZone: z.string().refine(isValidTimeZone, "Invalid IANA time zone."),
    durationMinutes: z.number().int().min(1).max(1440),
    intervalMinutes: z.number().int().min(1).max(1440).optional(),
    bufferBeforeMinutes: z.number().int().min(0).max(1440).default(0),
    bufferAfterMinutes: z.number().int().min(0).max(1440).default(0),
    mode: z.enum(["perCalendar", "allAvailable", "anyAvailable"]),
  })
  .strict();

const cancelSchema = z
  .object({
    cancellationReason: z.string().max(1000).optional(),
    cancelSubsequentBookings: z.literal(false).optional(),
  })
  .strict();

const rescheduleSchema = z
  .object({
    start: z.string().datetime({ offset: true }),
    rescheduledBy: z.string().email().optional(),
    reschedulingReason: z.string().max(1000).optional(),
  })
  .strict();

const guestSchema = z
  .object({
    email: z.string().email(),
    name: z.string().min(1).max(200).optional(),
    timeZone: z
      .string()
      .refine(isValidTimeZone, "Invalid IANA time zone.")
      .optional(),
  })
  .strict();

const addGuestsSchema = z
  .object({ guests: z.array(guestSchema).min(1).max(10) })
  .strict();

const idempotencyKeySchema = z.string().min(1).max(128);

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function requestHash(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

type Slot = { start: string; end: string };

function computeOpenSlots(
  fromMs: number,
  toMs: number,
  durationMinutes: number,
  intervalMinutes: number,
  bufferBeforeMinutes: number,
  bufferAfterMinutes: number,
  busy: Array<{ startUtc: string; endUtc: string }>,
): Slot[] {
  const durationMs = durationMinutes * 60_000;
  const intervalMs = intervalMinutes * 60_000;
  const beforeMs = bufferBeforeMinutes * 60_000;
  const afterMs = bufferAfterMinutes * 60_000;
  const intervals = busy.map((item) => ({
    start: new Date(item.startUtc).getTime(),
    end: new Date(item.endUtc).getTime(),
  }));
  const slots: Slot[] = [];
  for (let start = fromMs; start + durationMs <= toMs; start += intervalMs) {
    const end = start + durationMs;
    if (
      intervals.some(
        (item) => start - beforeMs < item.end && end + afterMs > item.start,
      )
    )
      continue;
    slots.push({
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
    });
  }
  return slots;
}

function calendarData(calendar: ProviderCalendarRow) {
  return {
    id: calendar.id,
    externalId: calendar.externalId,
    credentialId: compatibilityId(calendar.credentialId),
    delegationCredentialId: null,
    integration: calendar.provider,
    provider: calendar.provider,
    name: calendar.name,
    email: calendar.email,
    primary: calendar.primary,
    readOnly: calendar.readOnly,
    isSelected: calendar.isSelected,
    accessRole: calendar.accessRole,
    source: calendar.source,
    capabilities: calendar.capabilities,
    syncStatus: calendar.syncStatus,
    lastSyncedAt:
      calendar.lastSyncedAt == null
        ? null
        : new Date(calendar.lastSyncedAt).toISOString(),
  };
}

@Injectable()
export class CalV2PilotService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CalendarEffects) private readonly calendar: CalendarEffects,
    @Inject(BookingService) private readonly bookings: BookingService,
    @Inject(CalV2Service) private readonly cal: CalV2Service,
  ) {}

  async eventTypes(
    accountId: string,
    raw: unknown,
    allowedEventTypeIds?: string[] | null,
  ) {
    const query = eventTypesQuerySchema.parse(raw);
    const filters = [
      query.username ? sql` AND m.handle = ${query.username}` : sql``,
      query.teamSlug ? sql` AND t.slug = ${query.teamSlug}` : sql``,
      query.eventSlug ? sql` AND et.slug = ${query.eventSlug}` : sql``,
    ];
    const rows = await this.db.all<{
      id: string;
      title: string;
      slug: string;
      description: string | null;
      length_minutes: number;
      hidden: number;
      member_id: string | null;
      team_id: string | null;
      handle: string | null;
      team_slug: string | null;
      scheduling_type: string | null;
      locations: unknown;
      booking_fields: unknown;
      team_name: string | null;
    }>(
      sql`SELECT et.id, et.title, et.slug, et.description, et.length_minutes,
                 et.hidden, et.member_id, et.team_id, m.handle,
                 t.slug AS team_slug, t.name AS team_name, et.scheduling_type,
                 et.locations, et.booking_fields
          FROM event_type et
          LEFT JOIN member m ON m.id = et.member_id
          LEFT JOIN team t ON t.id = et.team_id
          WHERE et.account_id = ${accountId} AND et.hidden = 0
            ${filters[0]}${filters[1]}${filters[2]}
          ORDER BY et.created_at ASC, et.id ASC`,
    );
    return rows
      .filter(
        (row) => !allowedEventTypeIds || allowedEventTypeIds.includes(row.id),
      )
      .map((row) => ({
        id: compatibilityId(row.id),
        daptaId: row.id,
        lengthInMinutes: row.length_minutes,
        title: row.title,
        slug: row.slug,
        description: row.description,
        hidden: row.hidden === 1,
        username: row.handle,
        teamSlug: row.team_slug,
        schedulingType: row.scheduling_type,
        type: row.team_id ? "team" : "personal",
        // The column holds ONE location (a `{ kind, detail }` object, or legacy
        // free text); the v2 contract declares an array, so normalize to a
        // 0-or-1 element list rather than leaking a bare object into it.
        locations: (() => {
          const loc = parseEventLocation(parseJsonColumn<unknown>(row.locations, null));
          return loc ? [loc] : [];
        })(),
        bookingFields: parseJsonColumn<unknown[]>(row.booking_fields, []),
        team:
          row.team_id && row.team_slug && row.team_name
            ? {
                id: compatibilityId(row.team_id),
                daptaId: row.team_id,
                slug: row.team_slug,
                name: row.team_name,
              }
            : null,
      }));
  }

  async calendars(accountId: string) {
    const connections = await listCalendarConnections(this.db, accountId);
    const groups: Array<Record<string, unknown>> = [];
    const failures: Array<Record<string, unknown>> = [];
    for (const connection of connections) {
      let discovered: ProviderCalendarRow[] = [];
      try {
        const summaries = await this.calendar.provider.listCalendars(
          connection.connectionRef,
        );
        for (const summary of summaries) {
          const capabilities = summary.capabilities ?? {
            canRead: !summary.readOnly,
            canReadFreeBusy: true,
            canCreate: false,
            canUpdate: false,
            canDelete: false,
          };
          discovered.push(
            await upsertProviderCalendar(this.db, {
              connection,
              externalId: summary.id,
              name: summary.name,
              email: summary.primaryEmail,
              primary: summary.isPrimary === true,
              readOnly: summary.readOnly !== false,
              accessRole: summary.accessRole ?? "none",
              source: summary.source ?? "shared",
              capabilities,
            }),
          );
        }
      } catch {
        await markProviderCalendarSyncError(this.db, accountId, connection.id);
        discovered = await listProviderCalendars(
          this.db,
          accountId,
          connection.id,
        );
        failures.push({
          credentialId: compatibilityId(connection.id),
          code: "PROVIDER_UNAVAILABLE",
          message:
            "Live calendar discovery failed; cached data is marked stale.",
        });
      }
      groups.push({
        credentialId: compatibilityId(connection.id),
        integration: connection.provider,
        calendars: discovered.map(calendarData),
      });
    }
    const flat = groups.flatMap(
      (group) =>
        (group["calendars"] as ReturnType<typeof calendarData>[]) ?? [],
    );
    if (connections.length > 0 && flat.length === 0 && failures.length > 0)
      v2Error(
        503,
        "CALENDAR_PROVIDER_UNAVAILABLE",
        "Calendar discovery is temporarily unavailable.",
      );
    return {
      connectedCalendars: groups,
      destinationCalendar:
        flat.find((calendar) => calendar.primary && !calendar.readOnly) ?? null,
      failures,
    };
  }

  async availability(accountId: string, raw: unknown) {
    const input = availabilitySchema.parse(raw);
    const calendarIds = [...new Set(input.calendarIds)];
    if (calendarIds.length !== input.calendarIds.length)
      v2Error(400, "INVALID_REQUEST", "calendarIds must be unique.");
    const fromMs = new Date(input.from).getTime();
    const toMs = new Date(input.to).getTime();
    if (toMs <= fromMs)
      v2Error(400, "INVALID_REQUEST", "to must be after from.");
    if (toMs - fromMs > 31 * 86_400_000)
      v2Error(
        400,
        "RANGE_TOO_LARGE",
        "Calendar availability is limited to 31 days per request.",
      );

    const calendars: ProviderCalendarRow[] = [];
    for (const id of calendarIds) {
      const calendar = await getProviderCalendar(this.db, accountId, id);
      if (!calendar)
        v2Error(404, "RESOURCE_NOT_FOUND", "Calendar not found.", {
          calendarId: id,
        });
      calendars.push(calendar);
    }

    const results: Record<string, Slot[]> = {};
    const failures: Array<Record<string, unknown>> = [];
    for (const calendar of calendars) {
      if (!calendar.capabilities.canReadFreeBusy) {
        failures.push({
          calendarId: calendar.id,
          code: "CALENDAR_READ_FORBIDDEN",
          message: "The calendar does not permit free/busy reads.",
        });
        continue;
      }
      try {
        const busy = await this.calendar.provider.listBusy({
          connectionRefs: [calendar.connectionRef],
          calendarIds: [calendar.externalId],
          fromUtc: new Date(fromMs).toISOString(),
          toUtc: new Date(toMs).toISOString(),
        });
        results[calendar.id] = computeOpenSlots(
          fromMs,
          toMs,
          input.durationMinutes,
          input.intervalMinutes ?? input.durationMinutes,
          input.bufferBeforeMinutes,
          input.bufferAfterMinutes,
          busy,
        );
      } catch {
        failures.push({
          calendarId: calendar.id,
          code: "PROVIDER_UNAVAILABLE",
          message: "The provider could not read this calendar.",
        });
      }
    }
    const successful = Object.values(results);
    if (successful.length === 0) {
      if (
        failures.every(
          (failure) => failure["code"] === "CALENDAR_READ_FORBIDDEN",
        )
      )
        v2Error(
          403,
          "CALENDAR_READ_FORBIDDEN",
          "None of the requested calendars permit free/busy reads.",
          { failures },
        );
      v2Error(
        503,
        "CALENDAR_PROVIDER_UNAVAILABLE",
        "No requested calendar could be read.",
        { failures },
      );
    }

    const byStart = new Map<string, Slot>();
    for (const slots of successful)
      for (const slot of slots) byStart.set(slot.start, slot);
    let slots: Slot[] | undefined;
    if (input.mode === "anyAvailable")
      slots = [...byStart.values()].sort((a, b) =>
        a.start.localeCompare(b.start),
      );
    if (input.mode === "allAvailable") {
      const counts = new Map<string, number>();
      for (const calendarSlots of successful)
        for (const slot of calendarSlots)
          counts.set(slot.start, (counts.get(slot.start) ?? 0) + 1);
      slots = [...byStart.values()]
        .filter((slot) => counts.get(slot.start) === successful.length)
        .sort((a, b) => a.start.localeCompare(b.start));
    }
    return {
      timeZone: input.timeZone,
      mode: input.mode,
      ...(input.mode === "perCalendar" ? { calendars: results } : { slots }),
      partial: failures.length > 0,
      failures,
    };
  }

  async getBooking(
    accountId: string,
    uid: string,
    allowedEventTypeIds?: string[] | null,
  ) {
    return this.cal.bookingResponse(accountId, uid, allowedEventTypeIds);
  }

  private async mutate<T>(
    args: {
      accountId: string;
      keyId: string;
      method: string;
      path: string;
      idempotencyKey?: string;
      request: unknown;
      statusCode: number;
    },
    operation: (storedKey?: string) => Promise<T>,
  ): Promise<T> {
    if (!args.idempotencyKey) return operation();
    const key = idempotencyKeySchema.parse(args.idempotencyKey);
    const namespaceHash = hashApiValue(
      `${args.accountId}:${args.keyId}:${args.method}:${args.path}:${key}`,
    );
    const bodyHash = requestHash(args.request);
    const claim = await claimApiIdempotency(this.db, {
      namespaceHash,
      accountId: args.accountId,
      apiKeyId: args.keyId,
      method: args.method,
      path: args.path,
      requestHash: bodyHash,
    });
    if (claim.requestHash !== bodyHash)
      v2Error(
        409,
        "IDEMPOTENCY_KEY_REUSED",
        "Idempotency-Key was already used with a different request.",
      );
    if (claim.statusCode != null) return claim.responseBody as T;
    const response = await operation(`v2:${namespaceHash}`);
    await completeApiIdempotency(this.db, claim.id, args.statusCode, response);
    return response;
  }

  async cancel(
    accountId: string,
    uid: string,
    raw: unknown,
    idempotencyKey: string | undefined,
    keyId: string,
    allowedEventTypeIds?: string[] | null,
  ) {
    const body = cancelSchema.parse(raw ?? {});
    await this.cal.bookingResponse(accountId, uid, allowedEventTypeIds);
    return this.mutate(
      {
        accountId,
        keyId,
        method: "POST",
        path: `/v2/bookings/${uid}/cancel`,
        idempotencyKey,
        request: body,
        statusCode: 200,
      },
      async (storedKey) => {
        const outcome = await this.bookings.cancel(uid, {
          reason: body.cancellationReason,
          byHost: true,
          accountId,
          idempotencyKey: storedKey,
        });
        if ("error" in outcome)
          v2Error(outcome.status, outcome.error, outcome.message);
        return this.cal.bookingResponse(accountId, uid, allowedEventTypeIds);
      },
    );
  }

  async reschedule(
    accountId: string,
    uid: string,
    raw: unknown,
    idempotencyKey: string | undefined,
    keyId: string,
    allowedEventTypeIds?: string[] | null,
  ) {
    const body = rescheduleSchema.parse(raw);
    await this.cal.bookingResponse(accountId, uid, allowedEventTypeIds);
    return this.mutate(
      {
        accountId,
        keyId,
        method: "POST",
        path: `/v2/bookings/${uid}/reschedule`,
        idempotencyKey,
        request: body,
        statusCode: 201,
      },
      async (storedKey) => {
        const outcome = await rescheduleBookingV2(
          this.db,
          {
            accountId,
            uid,
            newStartMs: new Date(body.start).getTime(),
            rescheduledBy: body.rescheduledBy,
            reason: body.reschedulingReason,
            idempotencyKey: storedKey,
          },
          this.calendar.provider,
        );
        if (!outcome.ok) {
          const status =
            outcome.reason === "NOT_FOUND"
              ? 404
              : outcome.reason === "GONE"
                ? 410
                : outcome.reason === "INVALID_SLOT"
                  ? 400
                  : 409;
          v2Error(
            status,
            outcome.reason,
            "The booking could not be rescheduled.",
          );
        }
        if (!outcome.alreadyApplied)
          this.bookings.afterV2Reschedule(
            uid,
            outcome.uid,
            outcome.manageToken,
            outcome.previousStartUtc,
            outcome.status,
          );
        return this.cal.bookingResponse(
          accountId,
          outcome.uid,
          allowedEventTypeIds,
        );
      },
    );
  }

  async addGuests(
    accountId: string,
    uid: string,
    raw: unknown,
    idempotencyKey: string | undefined,
    keyId: string,
    allowedEventTypeIds?: string[] | null,
  ) {
    const body = addGuestsSchema.parse(raw);
    await this.cal.bookingResponse(accountId, uid, allowedEventTypeIds);
    return this.mutate(
      {
        accountId,
        keyId,
        method: "POST",
        path: `/v2/bookings/${uid}/guests`,
        idempotencyKey,
        request: body,
        statusCode: 200,
      },
      async () => {
        const outcome = await addGuestsToBooking(this.db, {
          accountId,
          uid,
          guests: body.guests,
        });
        if (!outcome.ok) {
          const status =
            outcome.reason === "NOT_FOUND"
              ? 404
              : outcome.reason === "GONE"
                ? 410
                : 422;
          v2Error(status, outcome.reason, "Guests could not be added.");
        }
        if (outcome.added > 0) this.bookings.afterGuestsChanged(uid);
        return this.cal.bookingResponse(accountId, uid, allowedEventTypeIds);
      },
    );
  }
}
