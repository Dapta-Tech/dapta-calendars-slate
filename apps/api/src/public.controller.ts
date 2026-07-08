import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ZodError } from 'zod';
import { BookingService } from './booking.service';
import { unwrap } from './http';

function badReq(err: unknown): never {
  if (err instanceof ZodError)
    throw new BadRequestException({ error: 'BAD_REQUEST', message: err.issues[0]?.message });
  throw err;
}

/** Public, unauthenticated booking surface (personal + team + manage). */
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
  async manageView(@Param('uid') uid: string, @Query('token') token: string) {
    return unwrap(await this.svc.manageView(uid, token ?? ''));
  }

  @Post('bookings/:uid/cancel')
  @HttpCode(200)
  async cancel(
    @Param('uid') uid: string,
    @Query('token') token: string,
    @Body() body: { reason?: string },
  ) {
    return unwrap(await this.svc.cancel(uid, { token, reason: body?.reason }));
  }

  @Post('bookings/:uid/reschedule')
  @HttpCode(200)
  async reschedule(
    @Param('uid') uid: string,
    @Query('token') token: string,
    @Body() body: { newStartUtc: string },
  ) {
    if (!body?.newStartUtc)
      throw new BadRequestException({ error: 'BAD_REQUEST', message: 'newStartUtc required' });
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
    if (!q.slug || !q.from || !q.to)
      throw new BadRequestException({ error: 'BAD_REQUEST', message: 'slug, from, to required' });
    const r = await this.svc.teamAvailability(accountCode, teamSlug, q.slug, q.from, q.to, q.timeZone);
    if (!r) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Team event not found.' });
    return r;
  }

  @Post('public/teams/:accountCode/:teamSlug/bookings')
  @HttpCode(201)
  async teamBook(
    @Param('accountCode') accountCode: string,
    @Param('teamSlug') teamSlug: string,
    @Body() body: { slug: string; startUtc: string; attendee: never; answers?: Record<string, unknown> },
  ) {
    return unwrap(await this.svc.teamBook(accountCode, teamSlug, body));
  }
}
