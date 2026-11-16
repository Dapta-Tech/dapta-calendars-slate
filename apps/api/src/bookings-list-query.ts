import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { bookingStatus } from '@slate/types';

/** An optional query value: absent and empty both mean "not given". */
const optionalQuery = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

/** A date the server can read; any form `new Date()` accepts stays accepted. */
const queryInstant = z
  .string()
  .refine((value) => !Number.isNaN(new Date(value).getTime()), 'Invalid date')
  .transform((value) => new Date(value).getTime());

/**
 * The window and page size of a bookings list (`GET /v1/host/bookings` and
 * `GET /v1/machine/bookings`). Only an unreadable value is refused: before, a
 * bad date read as NaN (a silently empty list) and a bad or repeated limit
 * or status reached SQL (a 500). An out-of-range limit is still clamped by the
 * repository, not refused.
 */
const bookingsListQuerySchema = z.object({
  from: optionalQuery(queryInstant),
  to: optionalQuery(queryInstant),
  // One of the booking statuses. A repeated `status` is an array and, like a
  // repeated `limit`, is refused here instead of reaching SQL (a 500).
  status: optionalQuery(z.enum(bookingStatus)),
  // The page cursor, opaque to the client. A repeated `cursor` is an array and
  // used to decode as garbage, silently restarting at page one; it is refused
  // like a repeated `limit`. A single unreadable cursor still behaves as before.
  cursor: optionalQuery(z.string().max(1000)),
  limit: optionalQuery(
    z
      .string()
      .regex(/^-?\d+$/, 'Expected an integer')
      .transform(Number),
  ),
});

export type BookingsListQuery = z.infer<typeof bookingsListQuerySchema>;

/** Read a bookings list query, or throw the 400 naming the first bad field. */
export function parseBookingsListQuery(query: Record<string, unknown>): BookingsListQuery {
  const checked = bookingsListQuerySchema.safeParse(query);
  if (checked.success) return checked.data;
  const issue = checked.error.issues[0]!;
  throw new BadRequestException({
    error: 'BAD_REQUEST',
    message: `${issue.path.join('.')}: ${issue.message}`,
  });
}
