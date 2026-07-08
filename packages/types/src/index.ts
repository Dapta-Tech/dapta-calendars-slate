/**
 * @slate/types — the typed contract shared by the API and the web app.
 * Zod schemas are the single source of truth: the API re-validates every
 * request against them, and the web forms derive their client-side validation
 * from the same schema (never trust the client; validate on both sides).
 */
import { z } from 'zod';

/** IANA time zone string (light validation; the engine trusts the platform DB). */
export const timeZoneSchema = z.string().min(1).max(64);

/** ISO-8601 UTC instant. */
export const isoUtcSchema = z.string().datetime({ offset: true });

// --- Availability ---------------------------------------------------------

export const availabilityQuerySchema = z.object({
  /** Public account code (URL segment). */
  accountCode: z.string().min(1),
  /** Member public handle (URL segment). */
  handle: z.string().min(1),
  /** Event-type slug (URL segment). */
  slug: z.string().min(1),
  /** Inclusive window start (ISO-8601 UTC). */
  from: isoUtcSchema,
  /** Exclusive window end (ISO-8601 UTC); the engine caps the span. */
  to: isoUtcSchema,
  /** IANA tz to express slots against (display only; slots are absolute). */
  timeZone: timeZoneSchema.optional(),
});
export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>;

export const slotSchema = z.object({
  /** Slot start instant (ISO-8601 UTC). */
  startUtc: isoUtcSchema,
});
export type Slot = z.infer<typeof slotSchema>;

export const availabilityResponseSchema = z.object({
  eventType: z.object({
    slug: z.string(),
    title: z.string(),
    lengthMinutes: z.number().int().positive(),
  }),
  timeZone: timeZoneSchema,
  slots: z.array(slotSchema),
});
export type AvailabilityResponse = z.infer<typeof availabilityResponseSchema>;

// --- Booking --------------------------------------------------------------

export const attendeeSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email(),
  timeZone: timeZoneSchema,
  notes: z.string().max(2000).optional(),
});
export type Attendee = z.infer<typeof attendeeSchema>;

export const createBookingSchema = z.object({
  accountCode: z.string().min(1),
  handle: z.string().min(1),
  slug: z.string().min(1),
  /** Chosen slot start (ISO-8601 UTC). */
  startUtc: isoUtcSchema,
  attendee: attendeeSchema,
  /** Idempotency key to dedupe retries. */
  idempotencyKey: z.string().max(200).optional(),
});
export type CreateBookingInput = z.infer<typeof createBookingSchema>;

export const bookingViewSchema = z.object({
  uid: z.string(),
  status: z.enum(['accepted', 'pending', 'cancelled', 'rejected']),
  title: z.string(),
  startUtc: isoUtcSchema,
  endUtc: isoUtcSchema,
  host: z.object({ name: z.string().nullable(), handle: z.string().nullable() }),
  attendee: z.object({ name: z.string(), email: z.string(), timeZone: z.string() }),
  /** One-time manage token URL (cancel/reschedule) — returned only on create. */
  manageUrl: z.string().optional(),
});
export type BookingView = z.infer<typeof bookingViewSchema>;

// --- Public page metadata -------------------------------------------------

export const publicProfileSchema = z.object({
  account: z.object({ code: z.string(), name: z.string() }),
  member: z.object({
    handle: z.string(),
    displayName: z.string().nullable(),
    timeZone: z.string(),
  }),
  eventTypes: z.array(
    z.object({
      slug: z.string(),
      title: z.string(),
      description: z.string().nullable(),
      lengthMinutes: z.number().int().positive(),
    }),
  ),
});
export type PublicProfile = z.infer<typeof publicProfileSchema>;

/** Problem-details error body (RFC 7807-ish) the API returns. */
export const apiErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
