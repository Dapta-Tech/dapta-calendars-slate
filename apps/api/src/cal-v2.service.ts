import { createHash } from "node:crypto";
import { HttpException, Inject, Injectable } from "@nestjs/common";
import type { Db, EventTypeRow, MemberRow } from "@slate/db";
import {
  getProviderCalendar,
  getAccountByCode,
  getEventTypeRowById,
  getMemberById,
  jsonParam,
  parseJsonColumn,
  scopedIdempotencyKey,
  sql,
} from "@slate/db";
import { isValidTimeZone, zoneOffsetMinutes, zonedDayKey } from "@slate/shared";
import { z } from "zod";
import { BookingService } from "./booking.service";
import { isServiceError } from "./http";
import { DB } from "./tokens";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const BOOKING_PATH = "/v2/bookings";

const eventTypeIdSchema = z
  .union([z.string().min(1), z.number().int().nonnegative()])
  .transform(String);

const eventSelectorShape = {
  eventTypeId: eventTypeIdSchema.optional(),
  eventTypeSlug: z.string().min(1).optional(),
  username: z.string().min(1).optional(),
  teamSlug: z.string().min(1).optional(),
  organizationSlug: z.string().min(1).optional(),
};

function validateSelector(
  value: {
    eventTypeId?: string;
    eventTypeSlug?: string;
    username?: string;
    teamSlug?: string;
  },
  ctx: z.RefinementCtx,
): void {
  const byId = !!value.eventTypeId;
  const byPersonalSlug =
    !!value.eventTypeSlug && !!value.username && !value.teamSlug;
  const byTeamSlug =
    !!value.eventTypeSlug && !!value.teamSlug && !value.username;
  if ([byId, byPersonalSlug, byTeamSlug].filter(Boolean).length !== 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "Use exactly one selector: eventTypeId, eventTypeSlug + username, or eventTypeSlug + teamSlug.",
    });
  }
}

const slotsQuerySchema = z
  .object({
    ...eventSelectorShape,
    start: z.string().min(1),
    end: z.string().min(1),
    timeZone: z.string().default("UTC"),
    duration: z.coerce.number().int().positive().optional(),
    format: z.enum(["time", "range"]).default("time"),
    bookingUidToReschedule: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    validateSelector(value, ctx);
    if (!isValidTimeZone(value.timeZone))
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["timeZone"],
        message: "Invalid IANA time zone.",
      });
  });

const bookingFieldsResponsesSchema = z.record(
  z.string(),
  z.union([z.string(), z.boolean(), z.array(z.string())]),
);

const metadataSchema = z
  .record(z.string().max(40), z.string().max(500))
  .refine(
    (value) => Object.keys(value).length <= 50,
    "metadata must contain at most 50 keys.",
  );

const createBookingSchema = z
  .object({
    ...eventSelectorShape,
    start: z.string().datetime({ offset: true }),
    attendee: z
      .object({
        name: z.string().min(1).max(200),
        email: z.string().email(),
        timeZone: z.string().refine(isValidTimeZone, "Invalid IANA time zone."),
        phoneNumber: z.string().max(32).optional(),
        language: z.string().default("en"),
      })
      .strict(),
    guests: z.array(z.string().email()).max(10).default([]),
    bookingFieldsResponses: bookingFieldsResponsesSchema.default({}),
    metadata: metadataSchema.default({}),
    lengthInMinutes: z.number().int().positive().optional(),
    location: z.record(z.string(), z.unknown()).optional(),
    meetingUrl: z.string().url().optional(),
    reservationUid: z.string().min(1).optional(),
    destinationCalendarId: z.string().min(1).optional(),
    routing: z.unknown().optional(),
    emailVerificationCode: z.string().optional(),
    allowConflicts: z.boolean().optional(),
    allowBookingOutOfBounds: z.boolean().optional(),
    skipBookingLimits: z.boolean().optional(),
    instant: z.boolean().optional(),
    recurrence: z.unknown().optional(),
  })
  .strict()
  .superRefine(validateSelector);

const idempotencyKeySchema = z.string().min(1).max(128);

export type CalV2SlotsQuery = z.input<typeof slotsQuerySchema>;
export type CalV2CreateBooking = z.input<typeof createBookingSchema>;

interface ResolvedEvent {
  accountCode: string;
  eventType: EventTypeRow;
  kind: "personal" | "team";
  member?: MemberRow;
  team?: { id: string; slug: string; timeZone: string };
}

interface StoredMetadata {
  _publicMetadata?: Record<string, string>;
  _guests?: string[];
  _primaryAttendee?: { email: string; language: string };
  _destinationCalendar?: {
    id: string;
    connectionRef: string;
    externalId: string;
  };
  _idempotency?: {
    requestHash: string;
    response?: Record<string, unknown>;
  };
}

export function v2Error(
  statusCode: number,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): never {
  throw new HttpException(
    { status: "error", error: { code, message, details } },
    statusCode,
  );
}

function featureNotSupported(feature: string, message?: string): never {
  v2Error(
    422,
    "FEATURE_NOT_SUPPORTED",
    message ?? `${feature} is not supported by this API milestone.`,
    { feature },
  );
}

function boundary(value: string, end: boolean): string {
  if (DATE_ONLY.test(value)) {
    const parsed = new Date(
      `${value}${end ? "T23:59:59.999Z" : "T00:00:00.000Z"}`,
    );
    if (
      Number.isNaN(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== value
    )
      v2Error(400, "INVALID_REQUEST", `Invalid date: ${value}`);
    return parsed.toISOString();
  }
  const parsed = new Date(value);
  if (
    Number.isNaN(parsed.getTime()) ||
    !/(?:[zZ]|[+-]\d{2}:\d{2})$/.test(value)
  )
    v2Error(400, "INVALID_REQUEST", `Invalid ISO-8601 instant: ${value}`);
  return parsed.toISOString();
}

function zonedIso(utcIso: string, timeZone: string): string {
  const instant = new Date(utcIso);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const part = (type: string): string =>
    parts.find((item) => item.type === type)?.value ?? "";
  const offsetMinutes = zoneOffsetMinutes(instant, timeZone);
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absoluteOffset = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(absoluteOffset / 60)).padStart(2, "0")}:${String(
    absoluteOffset % 60,
  ).padStart(2, "0")}`;
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part(
    "second",
  )}.${String(instant.getUTCMilliseconds()).padStart(3, "0")}${offset}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Fixed-length one-way digest for non-credential idempotency inputs. */
function nonCredentialDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Stable, non-authoritative numeric alias for Cal-shaped response `id` fields. */
export function compatibilityId(value: string): number {
  // FNV-1a 64-bit folded into JavaScript's exact 53-bit integer range.
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(value, "utf8")) {
    hash ^= BigInt(byte);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return Number(hash & 0x1fffffffffffffn);
}

@Injectable()
export class CalV2Service {
  constructor(
    @Inject(BookingService) private readonly bookings: BookingService,
    @Inject(DB) private readonly db: Db,
  ) {}

  private async accountCode(accountId: string): Promise<string> {
    const account = await this.db.get<{ code: string }>(
      sql`SELECT code FROM account WHERE id = ${accountId} LIMIT 1`,
    );
    if (!account) v2Error(404, "RESOURCE_NOT_FOUND", "Event type not found.");
    return account.code;
  }

  private async eventTypeByCompatibleId(
    accountId: string,
    suppliedId: string,
  ): Promise<EventTypeRow | undefined> {
    const direct = await getEventTypeRowById(this.db, suppliedId);
    if (direct?.account_id === accountId) return direct;
    if (!/^\d+$/.test(suppliedId)) return undefined;
    const aliases = await this.db.all<{ id: string }>(
      sql`SELECT id FROM event_type WHERE account_id = ${accountId}`,
    );
    const matches = aliases.filter(
      (row) => compatibilityId(row.id) === Number(suppliedId),
    );
    return matches.length === 1
      ? getEventTypeRowById(this.db, matches[0]!.id)
      : undefined;
  }

  async resolveEvent(
    accountId: string,
    selector: {
      eventTypeId?: string;
      eventTypeSlug?: string;
      username?: string;
      teamSlug?: string;
      organizationSlug?: string;
    },
  ): Promise<ResolvedEvent> {
    if (selector.organizationSlug) {
      const organization = await getAccountByCode(
        this.db,
        selector.organizationSlug,
      );
      if (!organization || organization.id !== accountId)
        v2Error(404, "RESOURCE_NOT_FOUND", "Event type not found.");
    }

    let eventType: EventTypeRow | undefined;
    if (selector.eventTypeId) {
      eventType = await this.eventTypeByCompatibleId(
        accountId,
        selector.eventTypeId,
      );
    } else if (selector.username && selector.eventTypeSlug) {
      const row = await this.db.get<{ id: string }>(
        sql`SELECT et.id FROM event_type et
            JOIN member m ON m.id = et.member_id
            WHERE et.account_id = ${accountId} AND m.handle = ${selector.username}
              AND et.slug = ${selector.eventTypeSlug} AND et.hidden = 0 LIMIT 1`,
      );
      eventType = row ? await getEventTypeRowById(this.db, row.id) : undefined;
    } else if (selector.teamSlug && selector.eventTypeSlug) {
      const row = await this.db.get<{ id: string }>(
        sql`SELECT et.id FROM event_type et
            JOIN team t ON t.id = et.team_id
            WHERE et.account_id = ${accountId} AND t.slug = ${selector.teamSlug}
              AND et.slug = ${selector.eventTypeSlug} AND et.hidden = 0 LIMIT 1`,
      );
      eventType = row ? await getEventTypeRowById(this.db, row.id) : undefined;
    }
    if (!eventType || eventType.account_id !== accountId)
      v2Error(404, "RESOURCE_NOT_FOUND", "Event type not found.");

    const accountCode = await this.accountCode(accountId);
    if (eventType.team_id) {
      const team = await this.db.get<{
        id: string;
        slug: string;
        time_zone: string;
      }>(
        sql`SELECT id, slug, time_zone FROM team
            WHERE id = ${eventType.team_id} AND account_id = ${accountId} LIMIT 1`,
      );
      if (!team) v2Error(404, "RESOURCE_NOT_FOUND", "Event type not found.");
      return {
        accountCode,
        eventType,
        kind: "team",
        team: { id: team.id, slug: team.slug, timeZone: team.time_zone },
      };
    }

    if (!eventType.member_id)
      v2Error(404, "RESOURCE_NOT_FOUND", "Event type not found.");
    const member = await getMemberById(this.db, eventType.member_id);
    if (!member || member.account_id !== accountId || !member.handle)
      v2Error(404, "RESOURCE_NOT_FOUND", "Event type not found.");
    return { accountCode, eventType, kind: "personal", member };
  }

  async slots(
    accountId: string,
    raw: CalV2SlotsQuery,
    allowedEventTypeIds?: string[] | null,
  ) {
    const query = slotsQuerySchema.parse(raw);
    if (query.bookingUidToReschedule)
      featureNotSupported(
        "bookingUidToReschedule",
        "Reschedule exclusion is scheduled for the booking lifecycle milestone.",
      );
    const from = boundary(query.start, false);
    const to = boundary(query.end, true);
    if (new Date(to).getTime() <= new Date(from).getTime())
      v2Error(400, "INVALID_REQUEST", "end must be after start.");

    const resolved = await this.resolveEvent(accountId, query);
    if (
      allowedEventTypeIds &&
      !allowedEventTypeIds.includes(resolved.eventType.id)
    )
      v2Error(404, "RESOURCE_NOT_FOUND", "Event type not found.");
    if (query.duration && query.duration !== resolved.eventType.length_minutes)
      featureNotSupported("variableDuration");

    const availability =
      resolved.kind === "team"
        ? await this.bookings.teamAvailability(
            resolved.accountCode,
            resolved.team!.slug,
            resolved.eventType.slug,
            from,
            to,
            query.timeZone,
          )
        : await this.bookings.availability({
            accountCode: resolved.accountCode,
            handle: resolved.member!.handle!,
            slug: resolved.eventType.slug,
            from,
            to,
            timeZone: query.timeZone,
          });
    if (!availability)
      v2Error(404, "RESOURCE_NOT_FOUND", "Event type not found.");

    const data: Record<string, Array<{ start: string; end?: string }>> = {};
    for (const slot of availability.slots) {
      const start = zonedIso(slot.startUtc, query.timeZone);
      const item: { start: string; end?: string } = { start };
      if (query.format === "range") {
        const endUtc = new Date(
          new Date(slot.startUtc).getTime() +
            resolved.eventType.length_minutes * 60_000,
        ).toISOString();
        item.end = zonedIso(endUtc, query.timeZone);
      }
      (data[zonedDayKey(slot.startUtc, query.timeZone)] ??= []).push(item);
    }
    return data;
  }

  private rejectUnsupportedBookingFields(
    input: z.output<typeof createBookingSchema>,
    eventType: EventTypeRow,
  ): void {
    if ((eventType.seats_per_time_slot ?? 1) > 1) featureNotSupported("seats");
    if (input.instant) featureNotSupported("instant");
    if (input.recurrence !== undefined) featureNotSupported("recurrence");
    if (input.routing !== undefined) featureNotSupported("routing");
    if (input.location !== undefined) featureNotSupported("locationOverride");
    if (input.meetingUrl !== undefined) featureNotSupported("meetingUrl");
    if (input.reservationUid !== undefined)
      featureNotSupported("reservationUid");
    if (input.emailVerificationCode !== undefined)
      featureNotSupported("emailVerification");
    if (input.allowConflicts) featureNotSupported("allowConflicts");
    if (input.allowBookingOutOfBounds)
      featureNotSupported("allowBookingOutOfBounds");
    if (input.skipBookingLimits) featureNotSupported("skipBookingLimits");
    if (
      input.lengthInMinutes &&
      input.lengthInMinutes !== eventType.length_minutes
    )
      featureNotSupported("variableDuration");
    if (input.attendee.language !== "en" && input.attendee.language !== "es")
      featureNotSupported(
        "attendeeLanguage",
        'This milestone supports attendee language values "en" and "es".',
      );
  }

  private async existingIdempotentBooking(
    accountId: string,
    storedKey: string,
    requestHash: string,
  ): Promise<{
    uid: string;
    response?: Record<string, unknown>;
  } | null> {
    // These rows are written by `createBooking` / `createTeamBooking`, which
    // namespace the stored key by account (#104) — so the lookup has to apply
    // the same transform or the replay silently misses and re-books.
    const prior = await this.db.get<{ uid: string; metadata: unknown }>(
      sql`SELECT uid, metadata FROM booking
          WHERE account_id = ${accountId}
            AND idempotency_key = ${scopedIdempotencyKey(accountId, storedKey)} LIMIT 1`,
    );
    if (!prior) return null;
    const metadata = parseJsonColumn<StoredMetadata>(prior.metadata, {});
    if (metadata._idempotency?.requestHash !== requestHash)
      v2Error(
        409,
        "IDEMPOTENCY_KEY_REUSED",
        "Idempotency-Key was already used with a different request.",
      );
    return {
      uid: prior.uid,
      response: metadata._idempotency.response,
    };
  }

  private async storeIdempotentResponse(
    accountId: string,
    uid: string,
    requestHash: string,
    response: Record<string, unknown>,
  ): Promise<void> {
    const booking = await this.db.get<{ id: string; metadata: unknown }>(
      sql`SELECT id, metadata FROM booking
          WHERE account_id = ${accountId} AND uid = ${uid} LIMIT 1`,
    );
    if (!booking) return;
    const metadata = parseJsonColumn<StoredMetadata>(booking.metadata, {});
    metadata._idempotency = { requestHash, response };
    await this.db.run(
      sql`UPDATE booking
          SET metadata = ${jsonParam(this.db, metadata)}
          WHERE account_id = ${accountId} AND id = ${booking.id}`,
    );
  }

  async bookingResponse(
    accountId: string,
    uid: string,
    allowedEventTypeIds?: string[] | null,
  ) {
    const booking = await this.db.get<{
      id: string;
      uid: string;
      title: string;
      status: string;
      start_ms: number;
      end_ms: number;
      location: string | null;
      responses: unknown;
      metadata: unknown;
      created_at: number;
      updated_at: number;
      event_type_id: string;
      event_slug: string;
      event_description: string | null;
      length_minutes: number;
      destination_calendar_id: string | null;
      meeting_url: string | null;
      cancellation_reason: string | null;
      cancelled_by: string | null;
      rescheduled_from_uid: string | null;
      rescheduled_to_uid: string | null;
      rescheduling_reason: string | null;
      rescheduled_by_email: string | null;
    }>(
      sql`SELECT b.id, b.uid, b.title, b.status, b.start_ms, b.end_ms, b.location,
                 b.responses, b.metadata, b.created_at, b.updated_at, b.event_type_id,
                 et.slug AS event_slug, et.description AS event_description,
                 et.length_minutes, et.destination_calendar_id, b.cancellation_reason,
                 b.cancelled_by, b.rescheduled_from_uid, b.rescheduled_to_uid,
                 b.rescheduling_reason, b.rescheduled_by_email,
                 (SELECT br.meeting_url FROM booking_reference br
                  WHERE br.booking_id = b.id AND br.meeting_url IS NOT NULL LIMIT 1) AS meeting_url
          FROM booking b
          JOIN event_type et ON et.id = b.event_type_id
          WHERE b.account_id = ${accountId} AND b.uid = ${uid} LIMIT 1`,
    );
    if (!booking) v2Error(404, "RESOURCE_NOT_FOUND", "Booking not found.");
    if (
      allowedEventTypeIds &&
      !allowedEventTypeIds.includes(booking.event_type_id)
    )
      v2Error(404, "RESOURCE_NOT_FOUND", "Booking not found.");

    const hosts = await this.db.all<{
      id: string;
      name: string | null;
      email: string | null;
      handle: string | null;
      time_zone: string;
    }>(
      sql`SELECT DISTINCT m.id, m.display_name AS name, m.email, m.handle, m.time_zone
          FROM member m
          WHERE m.account_id = ${accountId}
            AND (m.id = (SELECT host_member_id FROM booking WHERE id = ${booking.id})
              OR EXISTS (SELECT 1 FROM booking_host bh
                         WHERE bh.booking_id = ${booking.id} AND bh.member_id = m.id))`,
    );
    const attendeeRows = await this.db.all<{
      name: string;
      email: string;
      time_zone: string | null;
      phone: string | null;
    }>(
      sql`SELECT name, email, time_zone, phone FROM booking_attendee
          WHERE booking_id = ${booking.id} ORDER BY created_at ASC, id ASC`,
    );
    const internal = parseJsonColumn<StoredMetadata>(booking.metadata, {});
    const persistedGuests = await this.db.all<{
      email: string;
      name: string | null;
      time_zone: string | null;
    }>(
      sql`SELECT email, name, time_zone FROM booking_guest
          WHERE booking_id = ${booking.id} ORDER BY created_at ASC, id ASC`,
    );
    const guestSet = new Set(
      (internal._guests ?? []).map((email) => email.toLowerCase()),
    );
    const attendees = attendeeRows
      .filter((attendee) => !guestSet.has(attendee.email.toLowerCase()))
      .map((attendee) => ({
        name: attendee.name,
        email: attendee.email,
        displayEmail: attendee.email,
        timeZone: attendee.time_zone ?? "UTC",
        absent: false,
        language:
          attendee.email.toLowerCase() ===
          internal._primaryAttendee?.email.toLowerCase()
            ? internal._primaryAttendee.language
            : "en",
        ...(attendee.phone ? { phoneNumber: attendee.phone } : {}),
      }));

    return {
      id: compatibilityId(booking.id),
      uid: booking.uid,
      title: booking.title,
      description: booking.event_description,
      hosts: hosts.map((host) => ({
        id: compatibilityId(host.id),
        name: host.name,
        email: host.email,
        displayEmail: host.email,
        username: host.handle,
        timeZone: host.time_zone,
      })),
      status: booking.status,
      start: new Date(Number(booking.start_ms)).toISOString(),
      end: new Date(Number(booking.end_ms)).toISOString(),
      duration: booking.length_minutes,
      eventTypeId: compatibilityId(booking.event_type_id),
      eventType: {
        id: compatibilityId(booking.event_type_id),
        slug: booking.event_slug,
      },
      location: booking.location,
      absentHost: false,
      createdAt: new Date(Number(booking.created_at)).toISOString(),
      updatedAt: new Date(Number(booking.updated_at)).toISOString(),
      attendees,
      bookingFieldsResponses: parseJsonColumn<Record<string, unknown>>(
        booking.responses,
        {},
      ),
      guests: [
        ...(internal._guests ?? []),
        ...persistedGuests
          .map((guest) => guest.email)
          .filter(
            (email) =>
              !(internal._guests ?? []).some(
                (stored) => stored.toLowerCase() === email.toLowerCase(),
              ),
          ),
      ],
      metadata: internal._publicMetadata ?? {},
      meetingUrl: booking.meeting_url,
      destinationCalendarId:
        internal._destinationCalendar?.id ?? booking.destination_calendar_id,
      cancellationReason: booking.cancellation_reason,
      cancelledByEmail: booking.cancelled_by?.includes("@")
        ? booking.cancelled_by
        : null,
      rescheduledFromUid: booking.rescheduled_from_uid,
      rescheduledToUid: booking.rescheduled_to_uid,
      reschedulingReason: booking.rescheduling_reason,
      rescheduledByEmail: booking.rescheduled_by_email,
      icsUid: booking.uid,
    };
  }

  async createBooking(
    accountId: string,
    raw: CalV2CreateBooking,
    idempotencyKey?: string,
    allowedEventTypeIds?: string[] | null,
    keyIdentity = accountId,
  ) {
    const input = createBookingSchema.parse(raw);
    const resolved = await this.resolveEvent(accountId, input);
    if (
      allowedEventTypeIds &&
      !allowedEventTypeIds.includes(resolved.eventType.id)
    )
      v2Error(404, "RESOURCE_NOT_FOUND", "Event type not found.");
    this.rejectUnsupportedBookingFields(input, resolved.eventType);

    let destinationCalendar:
      { id: string; connectionRef: string; externalId: string } | undefined;
    if (input.destinationCalendarId) {
      if (resolved.kind !== "personal")
        featureNotSupported(
          "teamDestinationCalendar",
          "destinationCalendarId is only supported for personal event types because team host assignment is dynamic.",
        );
      const calendar = await getProviderCalendar(
        this.db,
        accountId,
        input.destinationCalendarId,
      );
      if (!calendar || calendar.memberId !== resolved.member!.id)
        v2Error(404, "RESOURCE_NOT_FOUND", "Calendar not found.");
      if (!calendar.capabilities.canCreate || calendar.readOnly)
        v2Error(
          403,
          "CALENDAR_READ_ONLY",
          "The selected calendar does not permit event creation.",
          { calendarId: calendar.id },
        );
      destinationCalendar = {
        id: calendar.id,
        connectionRef: calendar.connectionRef,
        externalId: calendar.externalId,
      };
    }

    const guests = [
      ...new Map(
        input.guests
          .filter(
            (email) =>
              email.toLowerCase() !== input.attendee.email.toLowerCase(),
          )
          .map((email) => [email.toLowerCase(), email]),
      ).values(),
    ];
    const requestHash = nonCredentialDigest(stableStringify(input));
    const storedKey = idempotencyKey
      ? `v2:${nonCredentialDigest(
          `${accountId}:${keyIdentity}:POST:${BOOKING_PATH}:${idempotencyKeySchema.parse(idempotencyKey)}`,
        )}`
      : undefined;
    if (storedKey) {
      const prior = await this.existingIdempotentBooking(
        accountId,
        storedKey,
        requestHash,
      );
      if (prior)
        return prior.response
          ? (prior.response as Awaited<ReturnType<typeof this.bookingResponse>>)
          : this.bookingResponse(accountId, prior.uid);
    }

    const internalMetadata = {
      _publicMetadata: input.metadata,
      _guests: guests,
      _primaryAttendee: {
        email: input.attendee.email,
        language: input.attendee.language,
      },
      ...(destinationCalendar
        ? { _destinationCalendar: destinationCalendar }
        : {}),
      ...(storedKey ? { _idempotency: { requestHash } } : {}),
    };
    const primary = {
      name: input.attendee.name,
      email: input.attendee.email,
      timeZone: input.attendee.timeZone,
      phone: input.attendee.phoneNumber,
    };
    const additionalAttendees = guests.map((email) => ({
      name: email,
      email,
      timeZone: input.attendee.timeZone,
    }));

    const outcome =
      resolved.kind === "team"
        ? await this.bookings.teamBook(
            resolved.accountCode,
            resolved.team!.slug,
            {
              slug: resolved.eventType.slug,
              startUtc: input.start,
              attendee: primary,
              additionalAttendees,
              answers: input.bookingFieldsResponses,
              metadata: internalMetadata,
              idempotencyKey: storedKey,
            },
            // API-key surface ⇒ exempt from the duplicate-booking guard (#69).
            // Passed as CONTEXT, never on the body: the public controller
            // forwards an unvalidated `@Body()` into that same parameter.
            { apiKeyWrite: true },
          )
        : await this.bookings.book(
            {
              accountCode: resolved.accountCode,
              handle: resolved.member!.handle!,
              slug: resolved.eventType.slug,
              startUtc: input.start,
              attendee: {
                ...primary,
                language: input.attendee.language as "en" | "es",
              },
              answers: input.bookingFieldsResponses,
            },
            false,
            // `onBehalf: false` above is deliberate (these bookings are
            // attributed to the invitee), so the duplicate-booking guard's
            // API-key exemption (#69) has to be stated separately. The
            // idempotency key is context for the same reason it is on the
            // team call below: the public controller forwards an unvalidated
            // body into the first parameter (#104).
            {
              additionalAttendees,
              metadata: internalMetadata,
              apiKeyWrite: true,
              idempotencyKey: storedKey,
            },
          );

    if (isServiceError(outcome)) {
      if (storedKey) {
        const prior = await this.existingIdempotentBooking(
          accountId,
          storedKey,
          requestHash,
        );
        if (prior)
          return prior.response
            ? (prior.response as Awaited<
                ReturnType<typeof this.bookingResponse>
              >)
            : this.bookingResponse(accountId, prior.uid);
      }
      const code =
        outcome.error === "INTAKE_INVALID"
          ? "BOOKING_FIELDS_INVALID"
          : outcome.error === "NOT_FOUND"
            ? "RESOURCE_NOT_FOUND"
            : outcome.error;
      const status = outcome.error === "INTAKE_INVALID" ? 422 : outcome.status;
      v2Error(status, code, outcome.message);
    }

    const response = await this.bookingResponse(accountId, outcome.uid);
    if (storedKey)
      await this.storeIdempotentResponse(
        accountId,
        outcome.uid,
        requestHash,
        response,
      );
    return response;
  }
}
