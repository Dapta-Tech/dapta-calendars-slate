import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ZodError } from 'zod';
import { BookingService } from './booking.service';
import { unwrap } from './http';
import { RateLimitGuard } from './rate-limit';

function badReq(err: unknown): never {
  if (err instanceof ZodError)
    throw new BadRequestException({ error: 'BAD_REQUEST', message: err.issues[0]?.message });
  throw err;
}

/**
 * Resolve the manage token from the least-leaky source available. Prefer the
 * `X-Manage-Token` header, then a POST body field, and only then the `?token=`
 * query param — kept for backward-compat because links already in the wild
 * (emails, calendar invites) carry the token in the query string. New links
 * should use the header/body so the token stays out of access logs and Referer.
 */
function manageToken(sources: {
  headerToken?: string;
  bodyToken?: string;
  queryToken?: string;
}): string {
  return (sources.headerToken || sources.bodyToken || sources.queryToken || '').trim();
}

/**
 * Public, unauthenticated booking surface (personal + team + manage).
 * Rate-limited per IP (P1-5) — this is the only surface an anonymous client can
 * hit, so booking spam / availability scraping / uid-token probing are throttled.
 */
@UseGuards(RateLimitGuard)
@Controller('v1')
export class PublicController {
  constructor(@Inject(BookingService) private readonly svc: BookingService) {}

  @Get('profiles/:accountCode/:handle')
  async profile(@Param('accountCode') accountCode: string, @Param('handle') handle: string) {
    const p = await this.svc.profile(accountCode, handle);
    if (!p) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Booking page not found.' });
    return p;
  }

  @Get('availability')
  async availability(@Query() query: Record<string, string>) {
    try {
      const r = await this.svc.availability(query);
      if (!r) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Booking page not found.' });
      return r;
    } catch (err) {
      badReq(err);
    }
  }

  @Post('reservations')
  @HttpCode(201)
  async reserve(@Body() body: unknown) {
    try {
      return unwrap(await this.svc.reserve(body));
    } catch (err) {
      badReq(err);
    }
  }

  /**
   * Give a soft hold back when the booker leaves the form (#135). Sits beside
   * `POST /v1/reservations` and inherits the same per-IP `RateLimitGuard` from
   * the controller.
   *
   * A POST with the uid in the BODY rather than `DELETE /v1/reservations/{uid}`:
   * the uid is the only thing authorising the release, and a path segment lands
   * in access logs and `Referer` — the same reason `manageToken()` above prefers
   * a header or a body field over `?token=`.
   *
   * Always 200 with the same body. Releasing a hold that is not yours, or one
   * that already expired or was consumed by a booking, is a no-op that reports
   * success, so this is never an oracle for whether a hold exists.
   */
  @Post('reservations/release')
  @HttpCode(200)
  async releaseReservation(@Body() body: unknown) {
    try {
      return await this.svc.release(body);
    } catch (err) {
      badReq(err);
    }
  }

  @Post('bookings')
  @HttpCode(201)
  async book(@Body() body: unknown) {
    try {
      return unwrap(await this.svc.book(body));
    } catch (err) {
      badReq(err);
    }
  }

  @Get('bookings/:uid')
  async manageView(
    @Param('uid') uid: string,
    @Headers('x-manage-token') headerToken: string | undefined,
    @Query('token') queryToken: string | undefined,
  ) {
    return unwrap(await this.svc.manageView(uid, manageToken({ headerToken, queryToken })));
  }

  /**
   * Slots this booking can MOVE to — the manage page's reschedule picker for a
   * team booking (#127). Scoped to the host set the booking already has, which
   * is the set the reschedule write validates against; the public team route
   * answers the wider question ("what does this event offer a new invitee?")
   * and for round-robin that union lists times this booking cannot take.
   *
   * Token-gated, and a bad token answers the same 404 an unknown uid does.
   */
  @Get('bookings/:uid/availability')
  async rescheduleAvailability(
    @Param('uid') uid: string,
    @Headers('x-manage-token') headerToken: string | undefined,
    @Query() q: Record<string, string>,
  ) {
    const token = manageToken({ headerToken, queryToken: q.token });
    try {
      const r = await this.svc.rescheduleAvailability(uid, token, q);
      if (!r) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Booking not found.' });
      return r;
    } catch (err) {
      badReq(err);
    }
  }

  @Post('bookings/:uid/cancel')
  @HttpCode(200)
  async cancel(
    @Param('uid') uid: string,
    @Headers('x-manage-token') headerToken: string | undefined,
    @Query('token') queryToken: string | undefined,
    @Body() body: { reason?: string; token?: string },
  ) {
    const token = manageToken({ headerToken, bodyToken: body?.token, queryToken });
    return unwrap(await this.svc.cancel(uid, { token, reason: body?.reason }));
  }

  @Post('bookings/:uid/reschedule')
  @HttpCode(200)
  async reschedule(
    @Param('uid') uid: string,
    @Headers('x-manage-token') headerToken: string | undefined,
    @Query('token') queryToken: string | undefined,
    @Body() body: { newStartUtc: string; token?: string },
  ) {
    if (!body?.newStartUtc)
      throw new BadRequestException({ error: 'BAD_REQUEST', message: 'newStartUtc required' });
    const token = manageToken({ headerToken, bodyToken: body?.token, queryToken });
    return unwrap(await this.svc.reschedule(uid, { token, newStartUtc: body.newStartUtc }));
  }

  // --- Teams (public) -----------------------------------------------------

  @Get('public/teams/:accountCode/:teamSlug')
  async teamProfile(@Param('accountCode') accountCode: string, @Param('teamSlug') teamSlug: string) {
    const p = await this.svc.teamProfile(accountCode, teamSlug);
    if (!p) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Team not found.' });
    return p;
  }

  @Get('public/teams/:accountCode/:teamSlug/availability')
  async teamAvailability(
    @Param('accountCode') accountCode: string,
    @Param('teamSlug') teamSlug: string,
    @Query() q: Record<string, string>,
  ) {
    // The service parses this query with `teamAvailabilityQuerySchema` and
    // clamps the window (#136). The presence check that used to stand here
    // bounded nothing and let an unparseable `from` through as a `NaN`; a zod
    // failure now answers 400 through `badReq`, as the personal route does.
    try {
      const r = await this.svc.teamAvailability(accountCode, teamSlug, q.slug, q.from, q.to, q.timeZone);
      if (!r) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Team event not found.' });
      return r;
    } catch (err) {
      badReq(err);
    }
  }

  @Post('public/teams/:accountCode/:teamSlug/bookings')
  @HttpCode(201)
  async teamBook(
    @Param('accountCode') accountCode: string,
    @Param('teamSlug') teamSlug: string,
    @Body() body: { slug: string; startUtc: string; attendee: never; answers?: Record<string, unknown> },
  ) {
    // Forward an EXPLICIT pick, never the raw body. Nest hands this handler the
    // parsed request object as-is and the app installs no global
    // ValidationPipe, so the type annotation above strips nothing at runtime —
    // whatever `teamBook` reads, an anonymous caller can set. `metadata` and
    // `idempotencyKey` are for the API-key surface, and `additionalAttendees`
    // become `booking_attendee` rows that the duplicate-booking guard (#69)
    // matches on, so accepting it here would let anyone name a victim and
    // block that address from booking this event. The personal path is already
    // safe by construction: `book()` runs the payload through
    // `createBookingSchema`, which drops unknown keys.
    return unwrap(
      await this.svc.teamBook(accountCode, teamSlug, {
        slug: body?.slug,
        startUtc: body?.startUtc,
        attendee: body?.attendee,
        answers: body?.answers,
      }),
    );
  }
}
