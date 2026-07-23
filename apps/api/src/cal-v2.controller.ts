import { randomUUID } from "node:crypto";
import {
  ArgumentsHost,
  Body,
  CallHandler,
  Catch,
  Controller,
  ExceptionFilter,
  ExecutionContext,
  Get,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Injectable,
  NestInterceptor,
  Param,
  Post,
  Query,
  Req,
  UseFilters,
  UseInterceptors,
} from "@nestjs/common";
import { ZodError } from "zod";
import {
  AuthService,
  type MachinePrincipal,
  type ReqLike,
} from "./auth.service";
import {
  CalV2Service,
  type CalV2CreateBooking,
  type CalV2SlotsQuery,
  v2Error,
} from "./cal-v2.service";
import { CalV2PilotService } from "./cal-v2-pilot.service";

export const CAL_V2_SLOTS_VERSION = "2024-09-04";
export const CAL_V2_BOOKINGS_VERSION = "2026-02-25";
export const CAL_V2_EVENT_TYPES_VERSION = "2024-06-14";
export const CAL_V2_GUESTS_VERSION = "2024-08-13";

interface V2Request extends ReqLike {
  v2RequestId?: string;
}

interface HttpResponse {
  status(code: number): HttpResponse;
  json(body: unknown): void;
  setHeader(name: string, value: string): void;
}

function safeRequestId(value: string | undefined): string {
  return value && /^[A-Za-z0-9._:-]{1,100}$/.test(value)
    ? value
    : `req_${randomUUID()}`;
}

@Injectable()
export class CalV2RequestIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest<V2Request>();
    const response = context.switchToHttp().getResponse<HttpResponse>();
    const supplied = request.headers["x-request-id"];
    request.v2RequestId = safeRequestId(
      Array.isArray(supplied) ? supplied[0] : supplied,
    );
    response.setHeader("X-Request-Id", request.v2RequestId);
    return next.handle();
  }
}

/** Keep every v2 failure in one predictable, PII-bounded Cal-style envelope. */
@Catch()
export class CalV2ExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<V2Request>();
    const response = http.getResponse<HttpResponse>();
    const requestId = request.v2RequestId ?? safeRequestId(undefined);
    let statusCode = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = "INTERNAL_ERROR";
    let message = "An unexpected error occurred.";
    let details: Record<string, unknown> = {};

    if (exception instanceof ZodError) {
      statusCode = HttpStatus.BAD_REQUEST;
      const issue = exception.issues[0];
      code = issue?.path.includes("timeZone")
        ? "INVALID_TIMEZONE"
        : "INVALID_REQUEST";
      message = issue?.message ?? "Invalid request.";
    } else if (exception instanceof HttpException) {
      statusCode = exception.getStatus();
      const body = exception.getResponse();
      if (body && typeof body === "object") {
        const record = body as Record<string, unknown>;
        const nested = record["error"];
        if (nested && typeof nested === "object") {
          const error = nested as Record<string, unknown>;
          if (typeof error["code"] === "string") code = error["code"];
          if (typeof error["message"] === "string") message = error["message"];
          if (error["details"] && typeof error["details"] === "object")
            details = error["details"] as Record<string, unknown>;
        } else {
          if (typeof record["error"] === "string") code = record["error"];
          if (typeof record["message"] === "string")
            message = record["message"];
        }
      } else if (typeof body === "string") {
        message = body;
      }
      const normalized: Record<string, string> = {
        BAD_REQUEST: "INVALID_REQUEST",
        UNAUTHENTICATED: "INVALID_API_KEY",
        FORBIDDEN: "INSUFFICIENT_SCOPE",
        NOT_FOUND: "RESOURCE_NOT_FOUND",
      };
      code = normalized[code] ?? code;
    }
    response.setHeader("X-Request-Id", requestId);
    response
      .status(statusCode)
      .json({ status: "error", error: { code, message, details, requestId } });
  }
}

function requireVersion(
  actual: string | undefined,
  accepted: readonly string[],
): void {
  if (!actual || !accepted.includes(actual))
    v2Error(
      400,
      "UNSUPPORTED_API_VERSION",
      `cal-api-version must be one of: ${accepted.join(", ")}.`,
      { acceptedVersions: accepted },
    );
}

@UseInterceptors(CalV2RequestIdInterceptor)
@UseFilters(CalV2ExceptionFilter)
@Controller("v2")
export class CalV2Controller {
  constructor(
    private readonly service: CalV2Service,
    private readonly pilot: CalV2PilotService,
    private readonly auth: AuthService,
  ) {}

  private async principal(
    req: ReqLike,
    scope:
      | "availability:read"
      | "bookings:read"
      | "bookings:write"
      | "calendars:read"
      | "event-types:read",
  ): Promise<MachinePrincipal> {
    const authorization = req.headers.authorization;
    const value = Array.isArray(authorization)
      ? authorization[0]
      : authorization;
    if (!value)
      v2Error(
        401,
        "AUTHENTICATION_REQUIRED",
        "Bearer API-key authentication is required.",
      );
    if (!value.startsWith("Bearer dcl_"))
      v2Error(
        401,
        "INVALID_API_KEY",
        "Authorization must contain a valid Bearer dcl_ API key.",
      );
    try {
      return await this.auth.resolveMachine(req, scope);
    } catch (error) {
      if (error instanceof HttpException && error.getStatus() === 403)
        v2Error(
          403,
          "INSUFFICIENT_SCOPE",
          `The API key requires scope ${scope}.`,
          {
            requiredScope: scope,
          },
        );
      v2Error(
        401,
        "INVALID_API_KEY",
        "The API key is invalid, expired, or revoked.",
      );
    }
  }

  @Get("slots")
  async slots(
    @Req() req: ReqLike,
    @Headers("cal-api-version") apiVersion: string | undefined,
    @Query() query: CalV2SlotsQuery,
  ) {
    requireVersion(apiVersion, [CAL_V2_SLOTS_VERSION]);
    const principal = await this.principal(req, "availability:read");
    return {
      status: "success" as const,
      data: await this.service.slots(
        principal.accountId,
        query,
        principal.eventTypeIds,
      ),
    };
  }

  @Post("bookings")
  @HttpCode(201)
  async book(
    @Req() req: ReqLike,
    @Headers("cal-api-version") apiVersion: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Body() body: CalV2CreateBooking,
  ) {
    requireVersion(apiVersion, [CAL_V2_BOOKINGS_VERSION]);
    const principal = await this.principal(req, "bookings:write");
    return {
      status: "success" as const,
      data: await this.service.createBooking(
        principal.accountId,
        body,
        idempotencyKey,
        principal.eventTypeIds,
        principal.keyId,
      ),
    };
  }

  @Get("event-types")
  async eventTypes(
    @Req() req: ReqLike,
    @Headers("cal-api-version") apiVersion: string | undefined,
    @Query() query: unknown,
  ) {
    requireVersion(apiVersion, [CAL_V2_EVENT_TYPES_VERSION]);
    const principal = await this.principal(req, "event-types:read");
    return {
      status: "success" as const,
      data: await this.pilot.eventTypes(
        principal.accountId,
        query,
        principal.eventTypeIds,
      ),
    };
  }

  @Get("calendars")
  async calendars(@Req() req: ReqLike) {
    const principal = await this.principal(req, "calendars:read");
    return {
      status: "success" as const,
      data: await this.pilot.calendars(principal.accountId),
    };
  }

  @Post("calendars/availability")
  @HttpCode(200)
  async calendarAvailability(@Req() req: ReqLike, @Body() body: unknown) {
    const principal = await this.principal(req, "calendars:read");
    return {
      status: "success" as const,
      data: await this.pilot.availability(principal.accountId, body),
    };
  }

  @Get("bookings/:uid")
  async getBooking(
    @Req() req: ReqLike,
    @Headers("cal-api-version") apiVersion: string | undefined,
    @Param("uid") uid: string,
  ) {
    requireVersion(apiVersion, [CAL_V2_BOOKINGS_VERSION]);
    const principal = await this.principal(req, "bookings:read");
    return {
      status: "success" as const,
      data: await this.pilot.getBooking(
        principal.accountId,
        uid,
        principal.eventTypeIds,
      ),
    };
  }

  @Post("bookings/:uid/cancel")
  @HttpCode(200)
  async cancelBooking(
    @Req() req: ReqLike,
    @Headers("cal-api-version") apiVersion: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Param("uid") uid: string,
    @Body() body: unknown,
  ) {
    requireVersion(apiVersion, [CAL_V2_BOOKINGS_VERSION]);
    const principal = await this.principal(req, "bookings:write");
    return {
      status: "success" as const,
      data: await this.pilot.cancel(
        principal.accountId,
        uid,
        body,
        idempotencyKey,
        principal.keyId,
        principal.eventTypeIds,
      ),
    };
  }

  @Post("bookings/:uid/reschedule")
  @HttpCode(201)
  async rescheduleBooking(
    @Req() req: ReqLike,
    @Headers("cal-api-version") apiVersion: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Param("uid") uid: string,
    @Body() body: unknown,
  ) {
    requireVersion(apiVersion, [CAL_V2_BOOKINGS_VERSION]);
    const principal = await this.principal(req, "bookings:write");
    return {
      status: "success" as const,
      data: await this.pilot.reschedule(
        principal.accountId,
        uid,
        body,
        idempotencyKey,
        principal.keyId,
        principal.eventTypeIds,
      ),
    };
  }

  @Post("bookings/:uid/guests")
  @HttpCode(200)
  async addGuests(
    @Req() req: ReqLike,
    @Headers("cal-api-version") apiVersion: string | undefined,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Param("uid") uid: string,
    @Body() body: unknown,
  ) {
    requireVersion(apiVersion, [CAL_V2_GUESTS_VERSION]);
    const principal = await this.principal(req, "bookings:write");
    return {
      status: "success" as const,
      data: await this.pilot.addGuests(
        principal.accountId,
        uid,
        body,
        idempotencyKey,
        principal.keyId,
        principal.eventTypeIds,
      ),
    };
  }
}
