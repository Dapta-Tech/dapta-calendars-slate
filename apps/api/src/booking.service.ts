import { Inject, Injectable } from '@nestjs/common';
import type { Db } from '@slate/db';
import { createBooking, getAvailability, getPublicProfile } from '@slate/db';
import { BookingNotifier } from '@slate/notifications';
import type { ServerEnv } from '@slate/config/env';
import {
  availabilityQuerySchema,
  createBookingSchema,
  type AvailabilityResponse,
  type BookingView,
  type PublicProfile,
} from '@slate/types';
import { DB, ENV, NOTIFIER } from './tokens';

export type ServiceError = { error: string; message: string };

@Injectable()
export class BookingService {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(NOTIFIER) private readonly notifier: BookingNotifier,
    @Inject(ENV) private readonly env: ServerEnv,
  ) {}

  async profile(accountCode: string, handle: string): Promise<PublicProfile | null> {
    const p = await getPublicProfile(this.db, accountCode, handle);
    return p ?? null;
  }

  async availability(raw: unknown): Promise<AvailabilityResponse | null> {
    const q = availabilityQuerySchema.parse(raw);
    const result = await getAvailability(this.db, {
      accountCode: q.accountCode,
      handle: q.handle,
      slug: q.slug,
      fromMs: new Date(q.from).getTime(),
      toMs: new Date(q.to).getTime(),
      displayTimeZone: q.timeZone,
    });
    if (!result) return null;
    return {
      eventType: result.eventType,
      timeZone: result.timeZone,
      slots: result.slots.map((startUtc) => ({ startUtc })),
    };
  }

  /** Returns the created booking, or a typed error the controller maps to HTTP. */
  async book(raw: unknown): Promise<BookingView | ServiceError> {
    const input = createBookingSchema.parse(raw);
    const outcome = await createBooking(this.db, {
      accountCode: input.accountCode,
      handle: input.handle,
      slug: input.slug,
      startMs: new Date(input.startUtc).getTime(),
      attendee: input.attendee,
      idempotencyKey: input.idempotencyKey,
    });

    if (!outcome.ok) {
      return outcome.reason === 'NOT_FOUND'
        ? { error: 'NOT_FOUND', message: 'No such booking page.' }
        : { error: 'SLOT_TAKEN', message: 'That time was just booked. Please pick another slot.' };
    }

    const b = outcome.booking;
    const startUtc = new Date(b.startMs).toISOString();
    const endUtc = new Date(b.endMs).toISOString();
    const manageUrl = outcome.manageToken
      ? `${this.env.PUBLIC_APP_URL}/manage/${outcome.manageToken}`
      : undefined;

    // Fire-and-forget: an email failure never affects the booking result.
    void this.notifier
      .sendConfirmation({
        uid: b.uid,
        title: b.title,
        startUtc,
        endUtc,
        host: { name: b.hostName },
        attendee: b.attendee,
        manageUrl,
      })
      .catch(() => undefined);

    return {
      uid: b.uid,
      status: b.status as BookingView['status'],
      title: b.title,
      startUtc,
      endUtc,
      host: { name: b.hostName, handle: b.hostHandle },
      attendee: b.attendee,
      manageUrl,
    };
  }
}
