import { randomUUID } from "node:crypto";
import { HttpException, type ArgumentsHost } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApiKey, createDb, migrate, seed, sql, type Db } from "@slate/db";
import { InMemoryCalendarProvider } from "@slate/calendar";
import { loadServerEnv } from "@slate/config/env";
import { BookingNotifier, NoopEmailProvider } from "@slate/notifications";
import type { AuthProvider, ReqLike } from "./auth.provider";
import { AuthService } from "./auth.service";
import { BookingService } from "./booking.service";
import { CalendarEffects } from "./calendar-effects";
import {
  CAL_V2_BOOKINGS_VERSION,
  CAL_V2_EVENT_TYPES_VERSION,
  CAL_V2_GUESTS_VERSION,
  CAL_V2_SLOTS_VERSION,
  CalV2Controller,
  CalV2ExceptionFilter,
} from "./cal-v2.controller";
import { CalV2Service } from "./cal-v2.service";
import { CalV2PilotService } from "./cal-v2-pilot.service";
import { EmailEffects } from "./email-effects";

const ENV = loadServerEnv({ NODE_ENV: "test" } as NodeJS.ProcessEnv);
const unusedHostProvider: AuthProvider = {
  name: "unused",
  resolveHost: () =>
    Promise.reject(new Error("host auth is not used in v2 machine tests")),
};

function exceptionBody(error: unknown): unknown {
  if (error && typeof error === "object" && "getResponse" in error)
    return (error as { getResponse(): unknown }).getResponse();
  return error;
}

describe("Cal-compatible v2 R1 contract", () => {
  let db: Db;
  let accountId: string;
  let introEventTypeId: string;
  let teamEventTypeId: string;
  let controller: CalV2Controller;
  let service: CalV2Service;
  let pilot: CalV2PilotService;
  let provider: InMemoryCalendarProvider;
  let calendarEffects: CalendarEffects;
  let request: ReqLike;

  beforeEach(async () => {
    db = await createDb("file::memory:");
    await migrate(db);
    await seed(db);
    accountId = (await db.get<{ id: string }>(
      sql`SELECT id FROM account WHERE code = 'acme'`,
    ))!.id;
    introEventTypeId = (await db.get<{ id: string }>(
      sql`SELECT id FROM event_type WHERE account_id = ${accountId} AND slug = 'intro-call'`,
    ))!.id;
    teamEventTypeId = (await db.get<{ id: string }>(
      sql`SELECT id FROM event_type WHERE account_id = ${accountId} AND slug = 'team-demo'`,
    ))!.id;

    const memberId = (await db.get<{ id: string }>(
      sql`SELECT id FROM member WHERE account_id = ${accountId} AND handle = 'alex-rivera'`,
    ))!.id;
    provider = new InMemoryCalendarProvider();
    provider.seedCalendars("pilot-connection", [
      {
        id: "primary@example.com",
        name: "Primary",
        primaryEmail: "primary@example.com",
        isPrimary: true,
        readOnly: false,
        accessRole: "owner",
        source: "primary",
        capabilities: {
          canRead: true,
          canReadFreeBusy: true,
          canCreate: true,
          canUpdate: true,
          canDelete: true,
        },
      },
      {
        id: "readonly@example.com",
        name: "Shared read-only",
        readOnly: true,
        accessRole: "reader",
        source: "shared",
        capabilities: {
          canRead: true,
          canReadFreeBusy: true,
          canCreate: false,
          canUpdate: false,
          canDelete: false,
        },
      },
    ]);
    await db.run(
      sql`INSERT INTO connected_calendar
            (id, account_id, member_id, provider, external_id, primary_email,
             is_destination, check_conflicts, created_at)
          VALUES (${randomUUID()}, ${accountId}, ${memberId}, ${"google"},
            ${"pilot-connection"}, ${"primary@example.com"}, 1, 1, ${Date.now()})`,
    );
    const calendar = new CalendarEffects(provider, db);
    calendarEffects = calendar;
    const email = new EmailEffects(
      new BookingNotifier(new NoopEmailProvider()),
      db,
    );
    const bookings = new BookingService(db, ENV, calendar, email);
    service = new CalV2Service(bookings, db);
    const auth = new AuthService(db, unusedHostProvider);
    pilot = new CalV2PilotService(db, calendar, bookings, service);
    controller = new CalV2Controller(service, pilot, auth);
    const key = await createApiKey(db, {
      accountId,
      name: "v2 contract",
      scopes: [
        "availability:read",
        "bookings:read",
        "bookings:write",
        "calendars:read",
        "event-types:read",
      ],
    });
    request = { headers: { authorization: `Bearer ${key.plaintext}` } };
  });

  afterEach(async () => {
    await db.close();
  });

  async function slots(eventTypeId = introEventTypeId) {
    return controller.slots(request, CAL_V2_SLOTS_VERSION, {
      eventTypeId,
      start: new Date().toISOString(),
      end: new Date(Date.now() + 10 * 86_400_000).toISOString(),
      timeZone: "America/Bogota",
    });
  }

  async function firstStart(eventTypeId = introEventTypeId): Promise<string> {
    const response = await slots(eventTypeId);
    return Object.values(response.data).flat()[0]!.start;
  }

  it("matches the Voice Worker slots fixture with current names and date-keyed data", async () => {
    const response = await slots();
    expect(response.status).toBe("success");
    expect(Object.keys(response.data).length).toBeGreaterThan(0);
    expect(Object.values(response.data).flat()[0]).toEqual(
      expect.objectContaining({ start: expect.any(String) }),
    );
  });

  it("supports format=range and personal/team slug selectors", async () => {
    const window = {
      start: new Date().toISOString(),
      end: new Date(Date.now() + 10 * 86_400_000).toISOString(),
      timeZone: "America/Bogota",
      format: "range" as const,
    };
    const personal = await controller.slots(request, CAL_V2_SLOTS_VERSION, {
      ...window,
      eventTypeSlug: "intro-call",
      username: "alex-rivera",
    });
    expect(Object.values(personal.data).flat()[0]).toMatchObject({
      start: expect.any(String),
      end: expect.any(String),
    });

    const team = await controller.slots(request, CAL_V2_SLOTS_VERSION, {
      ...window,
      eventTypeSlug: "team-demo",
      teamSlug: "sales",
    });
    expect(Object.values(team.data).flat().length).toBeGreaterThan(0);
  });

  it("routes a round-robin team eventTypeId through the existing team engine", async () => {
    const response = await slots(teamEventTypeId);
    expect(Object.values(response.data).flat().length).toBeGreaterThan(0);
  });

  it("returns exact booking fields, persists every guest, and omits REST startTime/endTime aliases", async () => {
    const response = await controller.book(
      request,
      CAL_V2_BOOKINGS_VERSION,
      "voice-worker-create-1",
      {
        eventTypeId: introEventTypeId,
        start: await firstStart(),
        attendee: {
          name: "Test Customer",
          email: "customer@example.com",
          timeZone: "America/Bogota",
          language: "es",
          phoneNumber: "+573000000000",
        },
        guests: ["guest-one@example.com", "guest-two@example.com"],
        metadata: { source: "voice-worker" },
        bookingFieldsResponses: {
          company: "Example",
          notes: "Created by contract fixture",
        },
      },
    );

    expect(response).toMatchObject({
      status: "success",
      data: {
        id: expect.any(Number),
        uid: expect.any(String),
        title: "Intro Call",
        start: expect.any(String),
        end: expect.any(String),
        status: "accepted",
        guests: ["guest-one@example.com", "guest-two@example.com"],
        metadata: { source: "voice-worker" },
      },
    });
    expect(response.data).not.toHaveProperty("startTime");
    expect(response.data).not.toHaveProperty("endTime");
    const count = await db.get<{ count: number }>(
      sql`SELECT COUNT(*) AS count FROM booking_attendee ba
          JOIN booking b ON b.id = ba.booking_id WHERE b.uid = ${response.data.uid}`,
    );
    expect(Number(count?.count)).toBe(3);
  });

  it("creates a team booking by ID and returns the assigned host", async () => {
    const response = await controller.book(
      request,
      CAL_V2_BOOKINGS_VERSION,
      "team-create-1",
      {
        eventTypeId: teamEventTypeId,
        start: await firstStart(teamEventTypeId),
        attendee: {
          name: "Team Customer",
          email: "team-customer@example.com",
          timeZone: "America/Bogota",
          language: "en",
        },
      },
    );
    expect(response.data.uid).toBeTruthy();
    expect(response.data.hosts).toHaveLength(1);
    expect(response.data.eventType.slug).toBe("team-demo");
  });

  it("replays a team booking on a repeated idempotency key", async () => {
    // The team write goes through `createTeamBooking`, a different insert from
    // the personal path, and the replay read is this service's own query
    // (#104). Both namespace the stored key by account; if only one did, the
    // lookup would silently miss and the retry would 409 instead of replaying.
    const body = {
      eventTypeId: teamEventTypeId,
      start: await firstStart(teamEventTypeId),
      attendee: {
        name: "Team Retry",
        email: "team-retry@example.com",
        timeZone: "America/Bogota",
        language: "en",
      },
    };
    const first = await controller.book(
      request,
      CAL_V2_BOOKINGS_VERSION,
      "flow-run-77:team-create",
      body,
    );
    const replay = await controller.book(
      request,
      CAL_V2_BOOKINGS_VERSION,
      "flow-run-77:team-create",
      body,
    );
    expect(replay).toEqual(first);
    const count = await db.get<{ count: number }>(
      sql`SELECT COUNT(*) AS count FROM booking WHERE uid = ${first.data.uid}`,
    );
    expect(Number(count?.count)).toBe(1);
  });

  it("reuses the original booking for the same idempotency key and rejects a changed request", async () => {
    const start = await firstStart();
    const body = {
      eventTypeId: introEventTypeId,
      start,
      attendee: {
        name: "Retry Customer",
        email: "retry@example.com",
        timeZone: "America/Bogota",
        language: "en",
      },
      bookingFieldsResponses: { company: "Example" },
    };
    const first = await controller.book(
      request,
      CAL_V2_BOOKINGS_VERSION,
      "flow-run-42:create",
      body,
    );
    await db.run(
      sql`UPDATE booking SET status = 'cancelled' WHERE uid = ${first.data.uid}`,
    );
    const replay = await controller.book(
      request,
      CAL_V2_BOOKINGS_VERSION,
      "flow-run-42:create",
      body,
    );
    expect(replay).toEqual(first);
    const count = await db.get<{ count: number }>(
      sql`SELECT COUNT(*) AS count FROM booking WHERE uid = ${first.data.uid}`,
    );
    expect(Number(count?.count)).toBe(1);

    await expect(
      controller.book(request, CAL_V2_BOOKINGS_VERSION, "flow-run-42:create", {
        ...body,
        attendee: { ...body.attendee, email: "different@example.com" },
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        (exceptionBody(error) as { error?: { code?: string } }).error?.code ===
        "IDEMPOTENCY_KEY_REUSED",
    );
  });

  it("discovers scoped personal/team event types and provider calendar permissions", async () => {
    const events = await controller.eventTypes(
      request,
      CAL_V2_EVENT_TYPES_VERSION,
      {},
    );
    expect(events.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: "intro-call", type: "personal" }),
        expect.objectContaining({ slug: "team-demo", type: "team" }),
      ]),
    );

    const calendars = await controller.calendars(request);
    expect(calendars.data.connectedCalendars[0]).toMatchObject({
      integration: "google",
      calendars: [
        expect.objectContaining({
          id: expect.stringMatching(/^cal_/),
          primary: true,
          readOnly: false,
          capabilities: expect.objectContaining({ canCreate: true }),
        }),
        expect.objectContaining({
          readOnly: true,
          capabilities: expect.objectContaining({ canCreate: false }),
        }),
      ],
    });
  });

  it("returns one/many calendar availability with explicit modes and read failures", async () => {
    const discovered = await controller.calendars(request);
    const calendars = discovered.data.connectedCalendars[0]![
      "calendars"
    ] as Array<{ id: string; externalId: string }>;
    const from = new Date(Date.now() + 60 * 60_000);
    from.setUTCMinutes(0, 0, 0);
    const to = new Date(from.getTime() + 2 * 60 * 60_000);
    provider.seedCalendarBusy("pilot-connection", calendars[0]!.externalId, [
      {
        startUtc: from.toISOString(),
        endUtc: new Date(from.getTime() + 30 * 60_000).toISOString(),
      },
    ]);
    const result = await controller.calendarAvailability(request, {
      calendarIds: calendars.map((calendar) => calendar.id),
      from: from.toISOString(),
      to: to.toISOString(),
      timeZone: "America/Bogota",
      durationMinutes: 30,
      intervalMinutes: 30,
      mode: "allAvailable",
    });
    expect(result.data).toMatchObject({
      mode: "allAvailable",
      partial: false,
      slots: expect.any(Array),
      failures: [],
    });
    expect((result.data as { slots: unknown[] }).slots).toHaveLength(3);
  });

  it("runs create/get/add-guest/reschedule/cancel with replay and linkage semantics", async () => {
    const created = await controller.book(
      request,
      CAL_V2_BOOKINGS_VERSION,
      "pilot:create",
      {
        eventTypeId: introEventTypeId,
        start: await firstStart(),
        attendee: {
          name: "Pilot Customer",
          email: "pilot@example.com",
          timeZone: "America/Bogota",
          language: "en",
        },
        metadata: { flowRunId: "pilot-run" },
        bookingFieldsResponses: { company: "Dapta" },
      },
    );
    const fetched = await controller.getBooking(
      request,
      CAL_V2_BOOKINGS_VERSION,
      created.data.uid,
    );
    expect(fetched.data).toEqual(created.data);

    const guests = await controller.addGuests(
      request,
      CAL_V2_GUESTS_VERSION,
      "pilot:guests",
      created.data.uid,
      {
        guests: [
          {
            email: "new-guest@example.com",
            name: "New Guest",
            timeZone: "America/Bogota",
          },
          { email: "NEW-GUEST@example.com" },
        ],
      },
    );
    expect(guests.data.guests).toEqual(["new-guest@example.com"]);
    expect(
      await controller.addGuests(
        request,
        CAL_V2_GUESTS_VERSION,
        "pilot:guests",
        created.data.uid,
        {
          guests: [
            {
              email: "new-guest@example.com",
              name: "New Guest",
              timeZone: "America/Bogota",
            },
            { email: "NEW-GUEST@example.com" },
          ],
        },
      ),
    ).toEqual(guests);

    const rescheduleStart = await firstStart();
    const rescheduleBody = {
      start: rescheduleStart,
      rescheduledBy: "pilot@example.com",
      reschedulingReason: "Pilot requested a new time",
    };
    const moved = await controller.rescheduleBooking(
      request,
      CAL_V2_BOOKINGS_VERSION,
      "pilot:reschedule",
      created.data.uid,
      rescheduleBody,
    );
    expect(moved.data).toMatchObject({
      uid: expect.not.stringMatching(created.data.uid),
      rescheduledFromUid: created.data.uid,
      guests: ["new-guest@example.com"],
      metadata: { flowRunId: "pilot-run" },
    });
    const old = await controller.getBooking(
      request,
      CAL_V2_BOOKINGS_VERSION,
      created.data.uid,
    );
    expect(old.data).toMatchObject({
      status: "cancelled",
      rescheduledToUid: moved.data.uid,
    });
    const replay = await controller.rescheduleBooking(
      request,
      CAL_V2_BOOKINGS_VERSION,
      "pilot:reschedule",
      created.data.uid,
      rescheduleBody,
    );
    expect(replay).toEqual(moved);

    const cancelled = await controller.cancelBooking(
      request,
      CAL_V2_BOOKINGS_VERSION,
      "pilot:cancel",
      moved.data.uid,
      { cancellationReason: "Pilot finished" },
    );
    expect(cancelled.data).toMatchObject({
      uid: moved.data.uid,
      status: "cancelled",
    });
    expect(
      await controller.cancelBooking(
        request,
        CAL_V2_BOOKINGS_VERSION,
        "pilot:cancel",
        moved.data.uid,
        { cancellationReason: "Pilot finished" },
      ),
    ).toEqual(cancelled);
  });

  it("rejects a read-only destination without creating a booking", async () => {
    const discovered = await controller.calendars(request);
    const readOnly = (
      discovered.data.connectedCalendars[0]!["calendars"] as Array<{
        id: string;
        readOnly: boolean;
      }>
    ).find((calendar) => calendar.readOnly)!;
    await expect(
      controller.book(request, CAL_V2_BOOKINGS_VERSION, "read-only", {
        eventTypeId: introEventTypeId,
        start: await firstStart(),
        destinationCalendarId: readOnly.id,
        attendee: {
          name: "No Write",
          email: "no-write@example.com",
          timeZone: "UTC",
          language: "en",
        },
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        (exceptionBody(error) as { error?: { code?: string } }).error?.code ===
        "CALENDAR_READ_ONLY",
    );
  });

  it("writes a personal booking to the exact discovered provider calendar", async () => {
    const discovered = await controller.calendars(request);
    const writable = (
      discovered.data.connectedCalendars[0]!["calendars"] as Array<{
        id: string;
        externalId: string;
        readOnly: boolean;
      }>
    ).find((calendar) => !calendar.readOnly)!;
    const created = await controller.book(
      request,
      CAL_V2_BOOKINGS_VERSION,
      "destination-calendar",
      {
        eventTypeId: introEventTypeId,
        start: await firstStart(),
        destinationCalendarId: writable.id,
        attendee: {
          name: "Destination Test",
          email: "destination@example.com",
          timeZone: "UTC",
          language: "en",
        },
        bookingFieldsResponses: { company: "Dapta" },
      },
    );
    await calendarEffects.runCalendarJob("create", created.data.uid);
    expect(provider.created.at(-1)).toMatchObject({
      connectionRef: "pilot-connection",
      calendarId: writable.externalId,
    });
  });

  it("uses the same lifecycle contract for an engine-assigned team host", async () => {
    const created = await controller.book(
      request,
      CAL_V2_BOOKINGS_VERSION,
      "team-lifecycle:create",
      {
        eventTypeId: teamEventTypeId,
        start: await firstStart(teamEventTypeId),
        attendee: {
          name: "Team Lifecycle",
          email: "team-lifecycle@example.com",
          timeZone: "America/Bogota",
          language: "en",
        },
      },
    );
    const target = await firstStart(teamEventTypeId);
    const moved = await controller.rescheduleBooking(
      request,
      CAL_V2_BOOKINGS_VERSION,
      "team-lifecycle:reschedule",
      created.data.uid,
      { start: target },
    );
    expect(moved.data).toMatchObject({
      uid: expect.any(String),
      rescheduledFromUid: created.data.uid,
      eventType: { slug: "team-demo" },
      hosts: [expect.objectContaining({ id: expect.any(Number) })],
    });
    await expect(
      controller.cancelBooking(
        request,
        CAL_V2_BOOKINGS_VERSION,
        "team-lifecycle:cancel",
        moved.data.uid,
        {},
      ),
    ).resolves.toMatchObject({
      data: { uid: moved.data.uid, status: "cancelled" },
    });
  });

  it("enforces endpoint versions, Bearer-only auth, scopes, and event-type allowlists", async () => {
    await expect(
      controller.slots(request, "2024-08-13", {
        eventTypeId: introEventTypeId,
        start: new Date().toISOString(),
        end: new Date(Date.now() + 86_400_000).toISOString(),
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        (exceptionBody(error) as { error?: { code?: string } }).error?.code ===
        "UNSUPPORTED_API_VERSION",
    );
    await expect(
      controller.slots(
        { headers: { "x-api-key": "dcl_not_allowed_on_v2" } },
        CAL_V2_SLOTS_VERSION,
        {
          eventTypeId: introEventTypeId,
          start: new Date().toISOString(),
          end: new Date(Date.now() + 86_400_000).toISOString(),
        },
      ),
    ).rejects.toSatisfy(
      (error: unknown) =>
        (exceptionBody(error) as { error?: { code?: string } }).error?.code ===
        "AUTHENTICATION_REQUIRED",
    );

    const scopedKey = await createApiKey(db, {
      accountId,
      name: "personal only",
      scopes: ["availability:read"],
      eventTypeIds: [introEventTypeId],
    });
    await expect(
      controller.slots(
        { headers: { authorization: `Bearer ${scopedKey.plaintext}` } },
        CAL_V2_SLOTS_VERSION,
        {
          eventTypeSlug: "team-demo",
          teamSlug: "sales",
          start: new Date().toISOString(),
          end: new Date(Date.now() + 86_400_000).toISOString(),
        },
      ),
    ).rejects.toSatisfy(
      (error: unknown) =>
        (exceptionBody(error) as { error?: { code?: string } }).error?.code ===
        "RESOURCE_NOT_FOUND",
    );

    const otherAccountId = "00000000-0000-4000-8000-000000000002";
    await db.run(
      sql`INSERT INTO account (id, code, name, created_at)
          VALUES (${otherAccountId}, ${"other-account"}, ${"Other Account"}, ${Date.now()})`,
    );
    const otherKey = await createApiKey(db, {
      accountId: otherAccountId,
      name: "other tenant",
      scopes: [
        "availability:read",
        "bookings:read",
        "bookings:write",
        "calendars:read",
      ],
    });
    await expect(
      controller.slots(
        { headers: { authorization: `Bearer ${otherKey.plaintext}` } },
        CAL_V2_SLOTS_VERSION,
        {
          eventTypeId: introEventTypeId,
          start: new Date().toISOString(),
          end: new Date(Date.now() + 86_400_000).toISOString(),
        },
      ),
    ).rejects.toSatisfy(
      (error: unknown) =>
        (exceptionBody(error) as { error?: { code?: string } }).error?.code ===
        "RESOURCE_NOT_FOUND",
    );

    const booking = await controller.book(
      request,
      CAL_V2_BOOKINGS_VERSION,
      "tenant-isolation:create",
      {
        eventTypeId: introEventTypeId,
        start: await firstStart(),
        attendee: {
          name: "Tenant Isolation",
          email: "tenant-isolation@example.com",
          timeZone: "UTC",
          language: "en",
        },
        bookingFieldsResponses: { company: "Dapta" },
      },
    );
    const foreignRequest = {
      headers: { authorization: `Bearer ${otherKey.plaintext}` },
    };
    await expect(
      controller.getBooking(
        foreignRequest,
        CAL_V2_BOOKINGS_VERSION,
        booking.data.uid,
      ),
    ).rejects.toSatisfy(
      (error: unknown) =>
        (exceptionBody(error) as { error?: { code?: string } }).error?.code ===
        "RESOURCE_NOT_FOUND",
    );
  });

  it("returns explicit 422 errors for recognized variants instead of silently narrowing", async () => {
    await expect(
      service.slots(accountId, {
        eventTypeId: introEventTypeId,
        start: new Date().toISOString(),
        end: new Date(Date.now() + 86_400_000).toISOString(),
        bookingUidToReschedule: "booking-uid",
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        (exceptionBody(error) as { error?: { code?: string } }).error?.code ===
        "FEATURE_NOT_SUPPORTED",
    );
  });

  it("serializes every HTTP failure with details, requestId, and X-Request-Id", () => {
    let statusCode = 0;
    let body: unknown;
    const headers: Record<string, string> = {};
    const response = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(value: unknown) {
        body = value;
      },
      setHeader(name: string, value: string) {
        headers[name] = value;
      },
    };
    const host = {
      switchToHttp: () => ({
        getRequest: () => ({ headers: {}, v2RequestId: "req_contract_test" }),
        getResponse: () => response,
      }),
    } as unknown as ArgumentsHost;

    new CalV2ExceptionFilter().catch(
      new HttpException(
        {
          status: "error",
          error: {
            code: "RESOURCE_NOT_FOUND",
            message: "Not found.",
            details: {},
          },
        },
        404,
      ),
      host,
    );
    expect(statusCode).toBe(404);
    expect(headers["X-Request-Id"]).toBe("req_contract_test");
    expect(body).toEqual({
      status: "error",
      error: {
        code: "RESOURCE_NOT_FOUND",
        message: "Not found.",
        details: {},
        requestId: "req_contract_test",
      },
    });
  });
});
