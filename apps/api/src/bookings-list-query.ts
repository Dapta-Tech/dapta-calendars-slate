import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';

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
 * reached SQL (a 500). An out-of-range limit is still clamped by the
 * repository, not refused.
 */
const bookingsListQuerySchema = z.object({
  from: optionalQuery(queryInstant),
  to: optionalQuery(queryInstant),
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
