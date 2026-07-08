/**
 * @slate/types — the typed contract shared by the API and the web app.
 * Zod schemas are the single source of truth: the API re-validates every
 * request against them, and the web forms derive their client-side validation
 * from the same schema (never trust the client; validate on both sides).
 */
import { z } from 'zod';

// --- Enums (string unions — portable across SQLite & Postgres) -------------

export const bookingStatus = ['accepted', 'pending', 'cancelled', 'rejected'] as const;
export type BookingStatus = (typeof bookingStatus)[number];

export const schedulingType = ['round_robin', 'collective'] as const;
export type SchedulingType = (typeof schedulingType)[number];

export const membershipRole = ['member', 'admin', 'owner'] as const;
export type MembershipRole = (typeof membershipRole)[number];

export const apiScope = ['availability:read', 'bookings:read', 'bookings:write'] as const;
export type ApiScope = (typeof apiScope)[number];

/** Custom intake-field kinds a booking page may ask. */
export const bookingFieldType = [
  'text',
  'textarea',
  'email',
  'phone',
  'number',
  'select',
  'checkbox',
] as const;
export type BookingFieldType = (typeof bookingFieldType)[number];

/** IANA time zone string (light validation; the engine trusts the platform DB). */
export const timeZoneSchema = z.string().min(1).max(64);

/** A per-event custom intake field definition (declared early — referenced widely). */
export const bookingFieldSchema = z.object({
  name: z.string().min(1).max(64),
  label: z.string().min(1).max(200),
  type: z.enum(bookingFieldType),
  required: z.boolean().default(false),
  placeholder: z.string().max(200).optional(),
  /** Options for select/checkbox fields. */
  options: z.array(z.string()).optional(),
});
export type BookingField = z.infer<typeof bookingFieldSchema>;

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
    /** Custom intake fields to render on the booking form. */
    bookingFields: z.array(bookingFieldSchema).default([]),
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
  /** E.164 phone (SMS/reminders). */
  phone: z.string().max(32).optional(),
  /** Drives notification/.ics language. */
  language: z.enum(['es', 'en']).optional(),
});
export type Attendee = z.infer<typeof attendeeSchema>;

/** Intake answers: fieldName -> value (string | boolean | string[]). */
export const intakeAnswersSchema = z.record(
  z.string(),
  z.union([z.string(), z.boolean(), z.array(z.string())]),
);
export type IntakeAnswers = z.infer<typeof intakeAnswersSchema>;

export const createBookingSchema = z.object({
  accountCode: z.string().min(1),
  handle: z.string().min(1),
  slug: z.string().min(1),
  /** Chosen slot start (ISO-8601 UTC). */
  startUtc: isoUtcSchema,
  attendee: attendeeSchema,
  /** Answers to the event type's custom intake fields. */
  answers: intakeAnswersSchema.optional(),
  /** Consume a held reservation (slot hold) if one exists. */
  reservationUid: z.string().max(200).optional(),
  /** Idempotency key to dedupe retries. */
  idempotencyKey: z.string().max(200).optional(),
});
export type CreateBookingInput = z.infer<typeof createBookingSchema>;

// --- Booking-page branding / studio ---------------------------------------

/** The 8 widget/slot style axes of the booking-page studio. */
export const bookingPageStyleSchema = z.object({
  cardStyle: z.enum(['flat', 'raised', 'bordered']).default('bordered'),
  cornerRadius: z.enum(['sharp', 'rounded', 'pill']).default('rounded'),
  buttonStyle: z.enum(['solid', 'outline', 'soft']).default('solid'),
  density: z.enum(['comfortable', 'compact']).default('comfortable'),
  font: z.enum(['sans', 'serif', 'mono']).default('sans'),
  slotShape: z.enum(['rectangle', 'pill']).default('rectangle'),
  themeMode: z.enum(['dark', 'light', 'system']).default('dark'),
  showCover: z.boolean().default(true),
});
export type BookingPageStyle = z.infer<typeof bookingPageStyleSchema>;

export const brandingSchema = z.object({
  displayName: z.string().max(200).nullable().optional(),
  avatarUrl: z.string().url().nullable().optional(),
  coverUrl: z.string().url().nullable().optional(),
  brandColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
  layout: z.enum(['month', 'column', 'list']).nullable().optional(),
  style: bookingPageStyleSchema.partial().optional(),
});
export type Branding = z.infer<typeof brandingSchema>;

// --- Reschedule / cancel --------------------------------------------------

export const rescheduleBookingSchema = z.object({
  uid: z.string().min(1),
  newStartUtc: isoUtcSchema,
  /** Attendee manage token (required for public reschedule). */
  manageToken: z.string().optional(),
  idempotencyKey: z.string().max(200).optional(),
});
export type RescheduleBookingInput = z.infer<typeof rescheduleBookingSchema>;

export const cancelBookingSchema = z.object({
  uid: z.string().min(1),
  reason: z.string().max(2000).optional(),
  manageToken: z.string().optional(),
});
export type CancelBookingInput = z.infer<typeof cancelBookingSchema>;

// --- Reservation holds ----------------------------------------------------

export const reserveSlotSchema = z.object({
  accountCode: z.string().min(1),
  handle: z.string().min(1),
  slug: z.string().min(1),
  startUtc: isoUtcSchema,
});
export type ReserveSlotInput = z.infer<typeof reserveSlotSchema>;

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
    avatarUrl: z.string().nullable(),
    coverUrl: z.string().nullable(),
    brandColor: z.string().nullable(),
    layout: z.string().nullable(),
    style: bookingPageStyleSchema.partial().nullable(),
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

// --- Teams (public team pages + round-robin) ------------------------------

export const teamProfileSchema = z.object({
  account: z.object({ code: z.string(), name: z.string() }),
  team: z.object({
    slug: z.string(),
    name: z.string(),
    logoUrl: z.string().nullable(),
    timeZone: z.string(),
  }),
  eventTypes: z.array(
    z.object({
      slug: z.string(),
      title: z.string(),
      description: z.string().nullable(),
      lengthMinutes: z.number().int().positive(),
      schedulingType: z.enum(schedulingType).nullable(),
    }),
  ),
});
export type TeamProfile = z.infer<typeof teamProfileSchema>;

// --- Account / identity ---------------------------------------------------

export const handleAvailableResponseSchema = z.object({
  handle: z.string(),
  available: z.boolean(),
  reason: z.string().nullable(),
});
export type HandleAvailableResponse = z.infer<typeof handleAvailableResponseSchema>;

export const meResponseSchema = z.object({
  accountId: z.string(),
  accountCode: z.string(),
  memberId: z.string(),
  handle: z.string().nullable(),
  displayName: z.string().nullable(),
  email: z.string().nullable(),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

/** Problem-details error body (RFC 7807-ish) the API returns. */
export const apiErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
