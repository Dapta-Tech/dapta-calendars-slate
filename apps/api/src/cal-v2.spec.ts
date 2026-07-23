import { HttpException, type ArgumentsHost } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApiKey, createDb, migrate, seed, sql, type Db } from "@slate/db";
import { DisabledCalendarProvider } from "@slate/calendar";
import { loadServerEnv } from "@slate/config/env";
import { BookingNotifier, NoopEmailProvider } from "@slate/notifications";
import type { AuthProvider, ReqLike } from "./auth.provider";
import { AuthService } from "./auth.service";
import { BookingService } from "./booking.service";
import { CalendarEffects } from "./calendar-effects";
import {
  CAL_V2_BOOKINGS_VERSION,
  CAL_V2_SLOTS_VERSION,
  CalV2Controller,
  CalV2ExceptionFilter,
} from "./cal-v2.controller";
import { CalV2Service } from "./cal-v2.service";
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

    const calendar = new CalendarEffects(new DisabledCalendarProvider(), db);
    const email = new EmailEffects(
      new BookingNotifier(new NoopEmailProvider()),
      db,
    );
    const bookings = new BookingService(db, ENV, calendar, email);
    service = new CalV2Service(bookings, db);
    const auth = new AuthService(db, unusedHostProvider);
    controller = new CalV2Controller(service, auth);
    const key = await createApiKey(db, {
      accountId,
      name: "v2 contract",
      scopes: ["availability:read", "bookings:write"],
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
      scopes: ["availability:read"],
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
