/**
 * @slate/types — the typed contract shared by the API and the web app.
 * Zod schemas are the single source of truth: the API re-validates every
 * request against them, and the web forms derive their client-side validation
 * from the same schema (never trust the client; validate on both sides).
 */
import { z } from 'zod';
import {
  AVAILABILITY_EMPTY_REASONS,
  LOCATION_DETAIL_MAX,
  LOCATION_KINDS,
  ONBOARDING_COHORTS,
  ONBOARDING_QUESTION_KEYS,
  ONBOARDING_TEMPLATE_IDS,
} from '@slate/engine';

export { LOCATION_KINDS, parseEventLocation } from '@slate/engine';
export type { EventLocation, LocationKind } from '@slate/engine';

// --- Enums (string unions — portable across SQLite & Postgres) -------------

export const bookingStatus = ['accepted', 'pending', 'cancelled', 'rejected'] as const;
export type BookingStatus = (typeof bookingStatus)[number];

export const schedulingType = ['round_robin', 'collective', 'fixed_round_robin'] as const;
export type SchedulingType = (typeof schedulingType)[number];

export const membershipRole = ['member', 'admin', 'owner'] as const;
export type MembershipRole = (typeof membershipRole)[number];

/**
 * WHERE a meeting happens. `conferencing` means "the calendar port mints a
 * meeting link"; the other three carry a host-authored `detail` (an address, a
 * number, free text). No conferencing vendor is named here — the running
 * product supplies a display label at runtime (ADR 0008).
 */
export const eventLocationSchema = z.object({
  kind: z.enum(LOCATION_KINDS),
  // Same cap the engine clamps to, so validation and normalization cannot drift.
  detail: z.string().max(LOCATION_DETAIL_MAX).nullable().optional(),
});
export type EventLocationDto = z.infer<typeof eventLocationSchema>;

/**
 * Account-level role (on `member`), distinct from the per-team `membershipRole`
 * even though the value names line up. `owner` administers the whole workspace
 * (+ transfer/delete), `admin` manages members and everyone's resources, `member`
 * is staff scoped to their own resources.
 */
export const accountRole = ['owner', 'admin', 'member'] as const;
export type AccountRole = (typeof accountRole)[number];

/** Member lifecycle within a workspace. */
export const memberStatus = ['active', 'invited', 'disabled'] as const;
export type MemberStatus = (typeof memberStatus)[number];

export const apiScope = [
  'availability:read',
  'bookings:read',
  'bookings:write',
  'calendars:read',
  'event-types:read',
] as const;
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
  'guests',
] as const;
export type BookingFieldType = (typeof bookingFieldType)[number];

/**
 * IANA time zone string, verified against the platform's own Intl database
 * (aliases like `US/Eastern` pass; garbage like `UT}fg` is rejected). Every
 * INPUT that persists a zone flows through this schema — the engine and the
 * render paths downstream assume a stored zone always formats.
 */
export const timeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(
    (tz) => {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    },
    {
      message: 'Unknown time zone (must be a valid IANA zone, e.g. America/Mexico_City)',
    },
  );

/** A per-event custom intake field definition (declared early — referenced widely). */
export const bookingFieldSchema = z.object({
  name: z.string().min(1).max(64),
  label: z.string().min(1).max(200),
  type: z.enum(bookingFieldType),
  required: z.boolean().default(false),
  placeholder: z.string().max(200).optional(),
  /** Options for select/checkbox fields. */
  options: z.array(z.string()).optional(),
  /** Phone fields: ISO 3166-1 alpha-2 the country selector starts on (QA4 fix 1b). */
  defaultCountry: z
    .string()
    .regex(/^[A-Za-z]{2}$/)
    .transform((v) => v.toUpperCase())
    .optional(),
});
export type BookingField = z.infer<typeof bookingFieldSchema>;

/* --- Per-event reminders -------------------------------------------------- */

/** At most this many reminders on one event type (#68 decision 7). */
export const MAX_REMINDERS_PER_EVENT = 10;
/** Lead bounds, shared with the retired account screen: 5 minutes … 28 days. */
export const MIN_REMINDER_LEAD_MINUTES = 5;
export const MAX_REMINDER_LEAD_MINUTES = 28 * 24 * 60;
export const MAX_REMINDER_SUBJECT = 200;
export const MAX_REMINDER_BODY = 5000;

/**
 * ONE reminder on an event type: its own switch, its own lead time, its own
 * subject and body (#68 decision 1). `kind` splits the two directions — a
 * `reminder` fires `leadMinutes` BEFORE start, a `follow_up` that many minutes
 * AFTER the end.
 *
 * `subject`/`body` NULL = the shipped default template, resolved in the host's
 * locale at enqueue time (same convention `notification_setting` uses), which
 * is what lets the copy-forward migration carry an account's untouched copy
 * without freezing today's English into every event type.
 *
 * `id` is unique WITHIN one event type's list, not globally: it is what the
 * deliver-time gate re-reads to decide whether a reminder queued days ago is
 * still wanted.
 */
export const eventReminderSchema = z.object({
  id: z.string().min(1).max(64),
  kind: z.enum(['reminder', 'follow_up']),
  enabled: z.boolean(),
  leadMinutes: z
    .number()
    .int()
    .min(MIN_REMINDER_LEAD_MINUTES)
    .max(MAX_REMINDER_LEAD_MINUTES),
  subject: z.string().max(MAX_REMINDER_SUBJECT).nullable(),
  body: z.string().max(MAX_REMINDER_BODY).nullable(),
});
export type EventReminder = z.infer<typeof eventReminderSchema>;

/**
 * The whole list as an event type accepts it. Caps are enforced here so the
 * API and the editor cannot disagree: at most 10 reminders, at most one
 * follow-up, no duplicate ids.
 */
export const eventRemindersSchema = z
  .array(eventReminderSchema)
  .max(MAX_REMINDERS_PER_EVENT + 1)
  .superRefine((rows, ctx) => {
    if (rows.filter((r) => r.kind === 'reminder').length > MAX_REMINDERS_PER_EVENT) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `At most ${MAX_REMINDERS_PER_EVENT} reminders per event type.`,
      });
    }
    if (rows.filter((r) => r.kind === 'follow_up').length > 1) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'At most one follow-up per event type.' });
    }
    if (new Set(rows.map((r) => r.id)).size !== rows.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Reminder ids must be unique.' });
    }
  });

/** Shipped reminder leads on a NEW event type: 24h and 1h, both on (#68 d4). */
export const DEFAULT_REMINDER_LEAD_MINUTES = [24 * 60, 60];
/** Shipped follow-up lead: 1h after the meeting ends — and OFF (#68 d5). */
export const DEFAULT_FOLLOW_UP_LEAD_MINUTES = 60;

/**
 * What a brand-new event type is born with. It lives in the CONTRACT package
 * because both ends need the same answer: the storage pre-fills a created row
 * with it, and the editor's create surface has to render the list the event is
 * about to get — a create form showing "no reminders" while the API stores 24h
 * + 1h (or worse, saving the empty list it displayed) is the same bug twice.
 */
export function defaultEventReminders(): EventReminder[] {
  return [
    ...DEFAULT_REMINDER_LEAD_MINUTES.map((leadMinutes, i) => ({
      id: `r${i + 1}`,
      kind: 'reminder' as const,
      enabled: true,
      leadMinutes,
      subject: null,
      body: null,
    })),
    {
      id: 'f1',
      kind: 'follow_up' as const,
      enabled: false,
      leadMinutes: DEFAULT_FOLLOW_UP_LEAD_MINUTES,
      subject: null,
      body: null,
    },
  ];
}

/** The `{{form.<field name>}}` namespace (#68 decision 2) — the prefix keeps a
 *  question named `location` from shadowing the built-in `{{location}}`. The
 *  editor already sanitizes field names to this charset. */
export const FORM_VARIABLE_PREFIX = 'form.';
export const formVariableNameRe = /^[A-Za-z0-9_]{1,64}$/;

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
  /** Group events (R23): seats still available at this slot. */
  spotsLeft: z.number().int().optional(),
  /** Group events (R23): total seats per slot. */
  capacity: z.number().int().optional(),
});
export type Slot = z.infer<typeof slotSchema>;

/**
 * Why `slots` came back empty for a CONFIGURATION reason. Absent on a sound
 * config (empty then means genuinely fully-booked / out of range). Codes are
 * safe to expose publicly; human copy is the client's job (admin gets
 * actionable detail, public pages get generic wording).
 */
export const availabilityEmptyReasonSchema = z.enum(AVAILABILITY_EMPTY_REASONS);
export type AvailabilityEmptyReason = z.infer<typeof availabilityEmptyReasonSchema>;

export const availabilityResponseSchema = z.object({
  eventType: z.object({
    slug: z.string(),
    title: z.string(),
    lengthMinutes: z.number().int().positive(),
    /** Custom intake fields to render on the booking form. */
    bookingFields: z.array(bookingFieldSchema).default([]),
    /** Team scheduling method (null for personal events). */
    schedulingType: z.enum(schedulingType).nullable().default(null),
    /** Where the meeting happens — rendered on the public booking page. */
    location: eventLocationSchema.nullable().default(null),
  }),
  timeZone: timeZoneSchema,
  slots: z.array(slotSchema),
  /** Present only when slots is empty because of a configuration error. */
  emptyReason: availabilityEmptyReasonSchema.optional(),
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
  // NO `idempotencyKey` here, deliberately (#104). This schema is what the
  // UNAUTHENTICATED `POST /v1/bookings` parses, and the booking page never
  // sends a key — only the API-key surfaces do. It reaches the service as
  // caller-supplied context instead, the same channel `metadata` and
  // `additionalAttendees` use and for the same reason. Since the schema drops
  // unknown keys, adding the field back here is the whole of the exposure.
});
export type CreateBookingInput = z.infer<typeof createBookingSchema>;

// --- Booking-page branding / studio ---------------------------------------

/** The 9 style axes of the booking-page studio (exact values from the prior version). */
export const bookingPageStyleSchema = z.object({
  template: z.enum(['classic', 'split', 'banded']).default('classic'),
  cardStyle: z.enum(['outline', 'elevated', 'filled']).default('outline'),
  corners: z.enum(['sharp', 'soft', 'round']).default('soft'),
  buttons: z.enum(['rounded', 'pill', 'square']).default('rounded'),
  density: z.enum(['comfortable', 'compact']).default('comfortable'),
  font: z.enum(['sans', 'rounded', 'serif']).default('sans'),
  slotLayout: z.enum(['grid', 'list']).default('grid'),
  dayGroup: z.enum(['flat', 'boxed']).default('flat'),
  slotSelect: z.enum(['soft', 'solid']).default('soft'),
  landingEnabled: z.boolean().default(true),
  defaultEventSlug: z.string().nullable().optional(),
  bio: z.string().max(2000).nullable().optional(),
});
export type BookingPageStyle = z.infer<typeof bookingPageStyleSchema>;

export const brandingSchema = z.object({
  displayName: z.string().max(200).nullable().optional(),
  avatarUrl: z.string().url().nullable().optional(),
  coverUrl: z.string().url().nullable().optional(),
  /** The single accent color (AA-clamped on render). */
  brandColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
  style: bookingPageStyleSchema.partial().optional(),
});
export type Branding = z.infer<typeof brandingSchema>;

// --- Reschedule / cancel --------------------------------------------------

/**
 * UNUSED — nothing parses this today. The public reschedule route builds its
 * own explicit object, so the `idempotencyKey` below reaches no code.
 *
 * Left in place rather than deleted, but flagged (#104): if this ever becomes
 * the parser for the unauthenticated reschedule route, that field is the same
 * trap the create payload just had — an anonymous caller writing into a column
 * with a global unique. Drop it before wiring this up, and pass the key as
 * caller-supplied context the way `BookingService.book()` does.
 */
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
  host: z.object({
    name: z.string().nullable(),
    handle: z.string().nullable(),
  }),
  attendee: z.object({
    name: z.string(),
    email: z.string(),
    timeZone: z.string(),
  }),
  /** Where the meeting happens (physical/phone/free-text) and, when generated,
   *  the meeting link — surfaced on the manage page. Both optional/nullable so
   *  existing responses stay valid. */
  location: z.string().nullable().optional(),
  /** The location KIND snapshotted at booking time; null on bookings written
   *  before it existed — the render falls back to `location` unchanged. */
  locationKind: z.enum(LOCATION_KINDS).nullable().optional(),
  meetingUrl: z.string().nullable().optional(),
  /** One-time manage token URL (cancel/reschedule) — returned only on create. */
  manageUrl: z.string().optional(),
  /** True when an idempotent replay returned the existing booking (B3). */
  deduplicated: z.boolean().optional(),
  /** Event context for the manage page's availability-backed reschedule picker. */
  reschedule: z.object({ accountCode: z.string(), handle: z.string(), slug: z.string() }).optional(),
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
  /** Account-level role + status — the FE gates admin-only surfaces on these. */
  role: z.enum(accountRole),
  status: z.enum(memberStatus),
  /**
   * The two onboarding gates (ADR 0002). Server-side verdicts, never derived
   * by the web app from an empty event-type list — deriving them client-side is
   * what causes the redirect loops and first-paint flicker this shape avoids.
   * Optional so a client pinned to the pre-O1 contract still parses.
   */
  onboardingRequired: z.boolean().optional(),
  setupRequired: z.boolean().optional(),
});
export type MeResponse = z.infer<typeof meResponseSchema>;

// --- Member management (workspace roster) ---------------------------------

/** Invite a member by email. Owner can never be invited (transferred, not granted). */
export const memberInviteSchema = z.object({
  email: z.string().email().max(320),
  role: z.enum(['admin', 'member']).optional(),
  displayName: z.string().max(200).nullable().optional(),
});
export type MemberInvite = z.infer<typeof memberInviteSchema>;

/** Patch a member's role and/or status. At least one field must be present. */
export const memberPatchSchema = z
  .object({
    role: z.enum(accountRole).optional(),
    status: z.enum(memberStatus).optional(),
  })
  .refine((v) => v.role !== undefined || v.status !== undefined, {
    message: 'Provide a role or status to change.',
  });
export type MemberPatch = z.infer<typeof memberPatchSchema>;

export const memberViewSchema = z.object({
  id: z.string(),
  email: z.string().nullable(),
  displayName: z.string().nullable(),
  handle: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  role: z.enum(accountRole),
  status: z.enum(memberStatus),
  createdAt: z.number(),
});
export type MemberViewDto = z.infer<typeof memberViewSchema>;

// --- Event-type CRUD ------------------------------------------------------

export const eventTypeInputSchema = z.object({
  slug: z.string().min(1).max(80),
  title: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  lengthMinutes: z.number().int().positive().max(1440),
  /** Where the meeting happens, as a location kind + optional detail. The kind
   *  is snapshotted onto each booking (`location_kind`) and the detail onto its
   *  `location`, so the manage page can show a Where that a later edit of this
   *  event type cannot rewrite. A bare string is still accepted — that is the
   *  legacy shape, coerced by `parseEventLocation`. */
  location: z
    .union([eventLocationSchema, z.string().max(LOCATION_DETAIL_MAX)])
    .nullable()
    .optional(),
  scheduleId: z.string().nullable().optional(),
  hidden: z.boolean().optional(),
  schedulingType: z.enum(schedulingType).nullable().optional(),
  minimumBookingNotice: z.number().int().min(0).optional(),
  beforeEventBuffer: z.number().int().min(0).optional(),
  afterEventBuffer: z.number().int().min(0).optional(),
  slotInterval: z.number().int().positive().nullable().optional(),
  requiresConfirmation: z.boolean().optional(),
  /** Duplicate-booking guard (#69): when true, one normalized email may hold
   *  at most one UPCOMING booking on this event type. Omitted ⇒ unchanged;
   *  absent on create ⇒ off, which is also what every pre-existing event type
   *  reads as. Host-initiated and API-key writes are never subject to it. */
  preventDuplicateBookings: z.boolean().optional(),
  seatsPerTimeSlot: z.number().int().positive().nullable().optional(),
  bookingFields: z.array(bookingFieldSchema).optional(),
  /** Reminders + follow-up, owned by the event type rather than the account
   *  (#68). Omitted on create ⇒ the shipped pre-fill (24h + 1h on, follow-up
   *  off); an EMPTY array is a deliberate "no reminders", never a reset. */
  reminders: eventRemindersSchema.optional(),
  /** For team events: the host member ids (round-robin pool). */
  hostMemberIds: z.array(z.string()).optional(),
  /** For team events: per-host round-robin detail. Takes precedence over hostMemberIds. */
  hosts: z
    .array(
      z.object({
        memberId: z.string(),
        priority: z.number().int().nullable().optional(),
        weight: z.number().int().positive().nullable().optional(),
        isFixed: z.boolean().optional(),
      }),
    )
    .optional(),
  teamId: z.string().nullable().optional(),
  /** PHASE 2 — per-event calendar selection (personal events only; ignored for
   *  team events — Phase 3). The set of connected_calendar ids this event
   *  checks for conflicts; empty clears the override. */
  conflictCalendarIds: z.array(z.string()).optional(),
  /** PHASE 2 — the connected_calendar id this event writes booked events to;
   *  null clears the override (falls back to the member-level destination). */
  destinationCalendarId: z.string().nullable().optional(),
});
export type EventTypeInput = z.infer<typeof eventTypeInputSchema>;

// --- Schedule CRUD --------------------------------------------------------

export const availabilityRuleInputSchema = z.object({
  /** Weekday numbers (0=Sun..6=Sat) for a recurring rule; null for an override. */
  days: z.array(z.number().int().min(0).max(6)).nullable(),
  startTime: z.string().regex(/^\d{2}:\d{2}$/),
  endTime: z.string().regex(/^\d{2}:\d{2}$/),
  /** "YYYY-MM-DD" for a date override; null for recurring. */
  date: z.string().nullable(),
});
export type AvailabilityRuleInput = z.infer<typeof availabilityRuleInputSchema>;

export const scheduleInputSchema = z.object({
  name: z.string().min(1).max(200),
  timeZone: timeZoneSchema,
  rules: z.array(availabilityRuleInputSchema).optional(),
});
export type ScheduleInput = z.infer<typeof scheduleInputSchema>;

// --- Team CRUD ------------------------------------------------------------

export const teamInputSchema = z.object({
  name: z.string().min(1).max(200),
  slug: z.string().min(1).max(80),
  bio: z.string().max(2000).nullable().optional(),
  // A https URL or a small data-URL logo. Capped server-side (~1MB image →
  // base64 overhead) so a non-UI caller can't push an unbounded TEXT value.
  logoUrl: z.string().max(1_500_000).nullable().optional(),
  timeZone: timeZoneSchema.optional(),
  hideBranding: z.boolean().optional(),
});
export type TeamInput = z.infer<typeof teamInputSchema>;

export const teamMemberInputSchema = z.object({
  memberId: z.string().min(1),
  role: z.enum(membershipRole).optional(),
});
export type TeamMemberInput = z.infer<typeof teamMemberInputSchema>;

/** Problem-details error body (RFC 7807-ish) the API returns. */
export const apiErrorSchema = z.object({
  error: z.string(),
  message: z.string(),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

// --- Onboarding: the two gates (ADR 0002) ---------------------------------

/**
 * A qualification answer. The VALUE is free text — Forms' bank mixes selects
 * with open fields and the IAM scores the raw string — so the contract bounds
 * length rather than shape: the account's write-once `onboarding` blob must
 * never become unbounded storage for whatever a client posts.
 */
export const onboardingAnswerSchema = z.string().trim().min(1).max(500);

/**
 * Gate 1's submission. Keys are restricted to the shared bank, so an unknown
 * key is REJECTED rather than stored — the blob is claimed write-once and can
 * never be corrected, and the IAM cannot score a key it does not know.
 */
export const onboardingQualificationSchema = z.object({
  answers: z
    .record(z.enum(ONBOARDING_QUESTION_KEYS), onboardingAnswerSchema)
    .refine((a) => Object.keys(a).length > 0, { message: 'at least one answer required' }),
});
export type OnboardingQualificationInput = z.infer<typeof onboardingQualificationSchema>;

/**
 * Gate 2's submission. The client may only ever NAME a template — never supply
 * a config — so the entire payload is one enum. Duration, slug and intake
 * fields come from the server-side registry in @slate/engine.
 */
export const onboardingSetupSchema = z.object({
  templateId: z.enum(ONBOARDING_TEMPLATE_IDS),
});
export type OnboardingSetupInput = z.infer<typeof onboardingSetupSchema>;

/** A template as offered to the wizard — copy already resolved to the locale. */
export const onboardingTemplateViewSchema = z.object({
  id: z.enum(ONBOARDING_TEMPLATE_IDS),
  slug: z.string(),
  lengthMinutes: z.number().int().positive(),
  title: z.string(),
  description: z.string(),
});
export type OnboardingTemplateView = z.infer<typeof onboardingTemplateViewSchema>;

/**
 * What `GET /v1/me/onboarding` hands the wizard: which gates are owed, which
 * questions this cohort answers, and the templates to choose from — one payload,
 * so the wizard never needs a second round-trip to learn which step to render.
 */
export const onboardingStateSchema = z.object({
  onboardingRequired: z.boolean(),
  setupRequired: z.boolean(),
  cohort: z.enum(ONBOARDING_COHORTS),
  questionKeys: z.array(z.enum(ONBOARDING_QUESTION_KEYS)),
  templates: z.array(onboardingTemplateViewSchema),
});
export type OnboardingState = z.infer<typeof onboardingStateSchema>;

// --- O2 growth: attribution + how a member reached the workspace ------------

/**
 * How a person arrived. Its own field, NEVER folded into `lead_source`.
 *
 * The CRM upsert is by email, so an invitee who is already a contact from an
 * earlier campaign must keep the better attribution they already have. A
 * workspace invitation is not campaign acquisition and must never be counted
 * as one (#65 → Growth funnel, constraint 1).
 */
export const ENTRY_TYPES = ['self_serve', 'workspace_invite'] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

/**
 * The attribution blob the web app claims onto a new account.
 *
 * Deliberately a CLOSED object over the seven allowlisted keys plus the
 * header-read `referer`: the claim is write-once, so an unknown key would be
 * stored permanently and could never be corrected. The parser in
 * `@slate/shared` already drops everything else; this is the same rule stated
 * again at the trust boundary, because the endpoint is reachable without it.
 *
 * `referer` is accepted here because by this point it has been read from the
 * request HEADER by the middleware — it is never sourced from a query
 * parameter, where it would be attacker-controlled text.
 */
/**
 * Must stay equal to `ATTRIBUTION_VALUE_MAX` in `@slate/shared`, which is where
 * the parser caps values before they ever reach this contract. Restated rather
 * than imported: `@slate/types` is the contract package and depends on nothing.
 */
const ATTRIBUTION_VALUE_MAX = 128;

export const attributionValueSchema = z.string().trim().min(1).max(ATTRIBUTION_VALUE_MAX);

export const attributionSchema = z
  .object({
    utm_source: attributionValueSchema.optional(),
    utm_medium: attributionValueSchema.optional(),
    utm_campaign: attributionValueSchema.optional(),
    utm_term: attributionValueSchema.optional(),
    utm_content: attributionValueSchema.optional(),
    gclid: attributionValueSchema.optional(),
    fbclid: attributionValueSchema.optional(),
    referer: attributionValueSchema.optional(),
  })
  .strict()
  .refine((a) => Object.values(a).some((v) => v !== undefined), {
    message: 'at least one attribution value required',
  });
export type AttributionInput = z.infer<typeof attributionSchema>;

/** `POST /v1/me/attribution` — claimed write-once, and only on a young account. */
export const attributionClaimSchema = z.object({ attribution: attributionSchema });
export type AttributionClaimInput = z.infer<typeof attributionClaimSchema>;

// --- H1a: CRM integration credentials (#63 / ADR 0001) ----------------------

/**
 * `POST /v1/integrations` — connect one account's CRM credential.
 *
 * The token travels IN only. Nothing in this file describes a response shape
 * carrying it back, and that is deliberate: "never echoed back to the client"
 * is a property of the contract, not a habit of whoever writes the controller.
 */
export const integrationConnectSchema = z.object({
  provider: z.literal('hubspot'),
  /** The pasted private-app token. Verified by use before anything is stored. */
  token: z.string().trim().min(8).max(512),
  /** Optional human name for the portal, so a status row is recognizable. */
  label: z.string().trim().max(80).optional(),
});
export type IntegrationConnectInput = z.infer<typeof integrationConnectSchema>;

/**
 * What a status view may show. `tokenLast4` and `label` are the WHOLE of what
 * identifies the credential; the cipher never leaves `@slate/db`.
 */
export interface IntegrationStatusView {
  provider: string;
  status: 'connected' | 'unhealthy' | 'disconnected';
  label: string | null;
  tokenLast4: string | null;
  lastCheckAt: number | null;
  lastCheckOk: boolean | null;
  lastCheckDetail: string | null;
  /**
   * The structured provider error. `requiredGranularScopes` is a scope NAME
   * list (verified in #74), so a UI can name the exact checkbox that was
   * missed rather than rendering prose.
   */
  lastErrorDetail: { category?: string | null; requiredGranularScopes?: string[] } | null;
}

/**
 * `GET /v1/integrations/capabilities` — what THIS DEPLOYMENT can do, as opposed
 * to what this account has done (H1b / #93).
 *
 * Both of the reasons connecting can be impossible are deployment
 * configuration: no adapter is selected (`CRM_PROVIDER=disabled`), or the
 * operator never set an encryption key. A browser has no other way to learn
 * either one — it would have to submit a credential and be refused, AFTER
 * sending the host off to create a private app. So the UI asks first and
 * disables the action, rather than offering a button whose only outcome is an
 * error.
 *
 * Deployment configuration, not account data — but the route still resolves a
 * principal and asserts admin, so nothing answers unauthenticated and no
 * principal learns anything about another account.
 */
export interface IntegrationCapabilities {
  /** The configured CRM's name, or null when no adapter is selected. */
  provider: string | null;
  /** Whether an adapter is selected at all (`CRM_PROVIDER` is not `disabled`). */
  enabled: boolean;
  /** Whether `INTEGRATION_ENCRYPTION_KEY` is present and parses. */
  canStoreCredentials: boolean;
  /**
   * The provider scope names a credential must carry, spelled as the provider
   * spells them. The connect dialog renders this as its checklist, so the
   * instructions a host follows come from the ADAPTER rather than from a copy
   * catalog — one list, which cannot drift and cannot be "translated". Empty
   * when no adapter is selected.
   */
  requiredScopes: string[];
}
