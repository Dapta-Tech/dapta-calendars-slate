import {
  BadRequestException,
  Body,
  ConflictException,
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

@Controller('health')
export class HealthController {
  @Get()
  health() {
    return { status: 'ok', service: 'slate-api' };
  }
}

@Controller('v1/profiles')
export class ProfilesController {
  constructor(@Inject(BookingService) private readonly svc: BookingService) {}

  @Get(':accountCode/:handle')
  async profile(@Param('accountCode') accountCode: string, @Param('handle') handle: string) {
    const p = await this.svc.profile(accountCode, handle);
    if (!p) throw new NotFoundException({ error: 'NOT_FOUND', message: 'Booking page not found.' });
    return p;
  }
}

@Controller('v1/availability')
export class AvailabilityController {
  constructor(@Inject(BookingService) private readonly svc: BookingService) {}

  @Get()
  async availability(@Query() query: Record<string, string>) {
    try {
      const result = await this.svc.availability(query);
      if (!result)
        throw new NotFoundException({ error: 'NOT_FOUND', message: 'Booking page not found.' });
      return result;
    } catch (err) {
      if (err instanceof ZodError) {
        throw new BadRequestException({ error: 'BAD_REQUEST', message: err.issues[0]?.message });
      }
      throw err;
    }
  }
}

@Controller('v1/bookings')
export class BookingsController {
  constructor(@Inject(BookingService) private readonly svc: BookingService) {}

  @Post()
  @HttpCode(201)
  async book(@Body() body: unknown) {
    try {
      const result = await this.svc.book(body);
      if ('error' in result) {
        if (result.error === 'NOT_FOUND') throw new NotFoundException(result);
        throw new ConflictException(result);
      }
      return result;
    } catch (err) {
      if (err instanceof ZodError) {
        throw new BadRequestException({ error: 'BAD_REQUEST', message: err.issues[0]?.message });
      }
      throw err;
    }
  }
}
