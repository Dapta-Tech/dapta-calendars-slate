/**
 * Hand-curated OpenAPI 3.1 description of Dapta Calendars' integrator-facing
 * surfaces. Dependency-free (the API validates with zod,
 * not class-validator, so there is no decorator metadata to auto-generate from).
 * Kept intentionally focused on the endpoints external integrations consume;
 * the full route list is in API-CONTRACT.md. R15: NO vendor/internal names here
 * (asserted by openapi.spec.ts).
 *
 * QA fix 4: every listed operation now carries its request-body schema, and
 * the machine cancel / add-attendee routes (real, shipping endpoints that were
 * missing here) are documented. openapi.spec.ts asserts controller↔spec parity
 * so the machine surface can't silently drift again.
 */

// --- Reusable schema fragments (components.schemas) -------------------------

const attendeeSchema = {
  type: 'object',
  required: ['name', 'email'],
  properties: {
    name: { type: 'string', maxLength: 200 },
    email: { type: 'string', format: 'email' },
    timeZone: { type: 'string', description: 'IANA zone (validated); defaults to UTC on the machine surface.' },
    notes: { type: 'string', maxLength: 2000 },
    phone: { type: 'string', maxLength: 32, description: 'E.164 preferred.' },
    language: { type: 'string', enum: ['en', 'es'], description: 'Notification/.ics language.' },
  },
} as const;

const isoUtc = { type: 'string', format: 'date-time', description: 'ISO-8601 UTC instant.' } as const;

const jsonBody = (schema: unknown, required = true) => ({
  required,
  content: { 'application/json': { schema } },
});

const calVersion = (value: string) => ({
  name: 'cal-api-version',
  in: 'header',
  required: true,
  schema: { type: 'string', enum: [value] },
  example: value,
});

const eventTypeId = {
  oneOf: [{ type: 'integer', minimum: 0 }, { type: 'string', minLength: 1 }],
  description:
    'Cal-compatible numeric alias or the native Dapta event-type ID. Use event-type discovery when available.',
} as const;

const errorResponse = (description: string) => ({
  description,
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/ErrorEnvelope' },
      example: {
        status: 'error',
        error: {
          code: 'INVALID_REQUEST',
          message: 'The request is invalid.',
          details: {},
          requestId: 'req_example',
        },
      },
    },
  },
});

export const openapiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'Dapta Calendars API',
    version: '2.0.0-r1',
    description:
      'Contract-first scheduling API. The implemented Cal-compatible R1 surface is GET /v2/slots and POST /v2/bookings; see API-CONTRACT.md for explicit gaps.',
    license: { name: 'MIT' },
  },
  servers: [
    { url: 'https://calendars-api.dapta.ai', description: 'Production' },
    { url: '/', description: 'This deployment' },
  ],
  tags: [
    { name: 'Cal-compatible R1', description: 'Implemented and fixture-tested Cal.com-compatible operations.' },
    { name: 'Legacy v1', description: 'Existing Dapta Calendars v1 operations; behavior is preserved.' },
  ],
  'x-dapta-compatibility': {
    implemented: ['GET /v2/slots', 'POST /v2/bookings'],
    nextMilestones: [
      'booking get/list/cancel/reschedule/guests',
      'slot reservations',
      'calendar discovery and multi-calendar availability',
      'event-type and team discovery',
    ],
    unsupportedVariants: [
      'recurrence',
      'seats',
      'instant meetings',
      'routing',
      'variable duration',
      'booking-time location and destination overrides',
      'reschedule exclusion',
    ],
  },
  components: {
    securitySchemes: {
      dclBearer: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'dcl_ API key',
        description: 'Authorization: Bearer dcl_<prefix>_<secret>. Never put a key in a URL.',
      },
      // Backward-compatible alias retained for v1 machine docs.
      apiKey: { type: 'http', scheme: 'bearer', description: 'dcl_ API key (Authorization: Bearer …).' },
      // Host/dashboard surface — pluggable AuthProvider (session/JWT in prod).
      hostSession: { type: 'apiKey', in: 'header', name: 'authorization', description: 'Host session (AuthProvider).' },
    },
    schemas: {
      Attendee: attendeeSchema,
      ErrorEnvelope: {
        type: 'object',
        required: ['status', 'error'],
        properties: {
          status: { type: 'string', const: 'error' },
          error: {
            type: 'object',
            required: ['code', 'message', 'details', 'requestId'],
            properties: {
              code: {
                type: 'string',
                examples: [
                  'INVALID_REQUEST',
                  'INVALID_TIMEZONE',
                  'UNSUPPORTED_API_VERSION',
                  'AUTHENTICATION_REQUIRED',
                  'INVALID_API_KEY',
                  'INSUFFICIENT_SCOPE',
                  'RESOURCE_NOT_FOUND',
                  'SLOT_TAKEN',
                  'IDEMPOTENCY_KEY_REUSED',
                  'BOOKING_FIELDS_INVALID',
                  'FEATURE_NOT_SUPPORTED',
                ],
              },
              message: { type: 'string' },
              details: { type: 'object', additionalProperties: true },
              requestId: { type: 'string' },
            },
          },
        },
      },
      Slot: {
        type: 'object',
        required: ['start'],
        properties: { start: isoUtc, end: isoUtc },
      },
      SlotsSuccess: {
        type: 'object',
        required: ['status', 'data'],
        properties: {
          status: { type: 'string', const: 'success' },
          data: {
            type: 'object',
            additionalProperties: {
              type: 'array',
              items: { $ref: '#/components/schemas/Slot' },
            },
          },
        },
      },
      CalAttendeeInput: {
        type: 'object',
        required: ['name', 'email', 'timeZone'],
        additionalProperties: false,
        properties: {
          name: { type: 'string', maxLength: 200 },
          email: { type: 'string', format: 'email' },
          timeZone: { type: 'string', example: 'America/Bogota' },
          language: {
            type: 'string',
            enum: ['en', 'es'],
            description: 'R1 supports en and es. Other Cal locales return FEATURE_NOT_SUPPORTED.',
          },
          phoneNumber: { type: 'string', maxLength: 32 },
        },
      },
      Booking: {
        type: 'object',
        required: [
          'id',
          'uid',
          'title',
          'status',
          'start',
          'end',
          'duration',
          'eventTypeId',
          'eventType',
          'hosts',
          'attendees',
          'guests',
          'metadata',
          'bookingFieldsResponses',
        ],
        properties: {
          id: {
            type: 'integer',
            description: 'Stable numeric compatibility alias. Lifecycle operations use uid.',
          },
          uid: { type: 'string' },
          title: { type: 'string' },
          description: { type: ['string', 'null'] },
          status: { type: 'string', enum: ['accepted', 'pending', 'cancelled', 'rejected'] },
          start: isoUtc,
          end: isoUtc,
          duration: { type: 'integer' },
          eventTypeId: { type: 'integer' },
          eventType: {
            type: 'object',
            required: ['id', 'slug'],
            properties: { id: { type: 'integer' }, slug: { type: 'string' } },
          },
          hosts: { type: 'array', items: { type: 'object', additionalProperties: true } },
          attendees: { type: 'array', items: { type: 'object', additionalProperties: true } },
          guests: { type: 'array', items: { type: 'string', format: 'email' } },
          metadata: { type: 'object', additionalProperties: { type: 'string' } },
          bookingFieldsResponses: { type: 'object', additionalProperties: true },
          location: { type: ['string', 'null'] },
          meetingUrl: { type: ['string', 'null'] },
          destinationCalendarId: { type: ['string', 'null'] },
          createdAt: isoUtc,
          updatedAt: isoUtc,
        },
      },
      BookingSuccess: {
        type: 'object',
        required: ['status', 'data'],
        properties: {
          status: { type: 'string', const: 'success' },
          data: { $ref: '#/components/schemas/Booking' },
        },
      },
    },
  },
  paths: {
    '/v2/slots': {
      get: {
        tags: ['Cal-compatible R1'],
        operationId: 'getV2Slots',
        summary: 'Get slots for a personal or team event type',
        description:
          'Current 2024-09-04 field names and date-keyed envelope. Supports personal, round-robin, collective, and fixed round-robin event types through the existing scheduling engine. format=range adds end.',
        security: [{ dclBearer: [] }],
        parameters: [
          calVersion('2024-09-04'),
          {
            name: 'eventTypeId',
            in: 'query',
            required: false,
            schema: eventTypeId,
            description: 'Use alone, or use one of the slug selector pairs.',
          },
          { name: 'eventTypeSlug', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'username', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'teamSlug', in: 'query', required: false, schema: { type: 'string' } },
          {
            name: 'organizationSlug',
            in: 'query',
            required: false,
            schema: { type: 'string' },
            description: 'Dapta account code/alias when organization context is used.',
          },
          {
            name: 'start',
            in: 'query',
            required: true,
            schema: { type: 'string' },
            example: '2026-07-24T00:00:00Z',
          },
          {
            name: 'end',
            in: 'query',
            required: true,
            schema: { type: 'string' },
            example: '2026-07-31T23:59:59Z',
          },
          {
            name: 'timeZone',
            in: 'query',
            required: false,
            schema: { type: 'string', default: 'UTC' },
            example: 'America/Bogota',
          },
          { name: 'duration', in: 'query', required: false, schema: { type: 'integer', minimum: 1 } },
          {
            name: 'format',
            in: 'query',
            required: false,
            schema: { type: 'string', enum: ['time', 'range'], default: 'time' },
          },
          {
            name: 'bookingUidToReschedule',
            in: 'query',
            required: false,
            schema: { type: 'string' },
            description: 'Recognized but returns 422 until the R2 lifecycle milestone.',
          },
        ],
        responses: {
          '200': {
            description: 'Date-keyed available slots; data is {} when no slots are available.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/SlotsSuccess' },
                example: {
                  status: 'success',
                  data: {
                    '2026-07-24': [{ start: '2026-07-24T10:00:00.000-05:00' }],
                  },
                },
              },
            },
          },
          '400': errorResponse('Invalid input, timezone, or API version.'),
          '401': errorResponse('Missing or invalid API key.'),
          '403': errorResponse('API key lacks availability:read.'),
          '404': errorResponse('Event type is absent, cross-tenant, or outside the key allowlist.'),
          '422': errorResponse('Recognized Cal variant is not implemented in R1.'),
        },
      },
    },
    '/v2/bookings': {
      post: {
        tags: ['Cal-compatible R1'],
        operationId: 'createV2Booking',
        summary: 'Create a personal or team booking',
        description:
          'Uses the current 2026-02-25 request and response names. All guests are persisted as booking attendees. Idempotency-Key is a Dapta extension and is required by the Flow Studio guide.',
        security: [{ dclBearer: [] }],
        parameters: [
          calVersion('2026-02-25'),
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: false,
            schema: { type: 'string', minLength: 1, maxLength: 128 },
            description:
              'Stable operation key. Same key/body returns the original booking; same key/different body returns 409.',
            example: 'flow-run-123:create-booking',
          },
        ],
        'x-dapta-idempotency': {
          extension: true,
          reuse: 'same request returns original response without repeated side effects',
          mismatch: '409 IDEMPOTENCY_KEY_REUSED',
          flowStudio: 'required',
        },
        requestBody: jsonBody({
          type: 'object',
          additionalProperties: false,
          required: ['start', 'attendee'],
          anyOf: [
            { required: ['eventTypeId'] },
            { required: ['eventTypeSlug', 'username'] },
            { required: ['eventTypeSlug', 'teamSlug'] },
          ],
          properties: {
            eventTypeId,
            eventTypeSlug: { type: 'string' },
            username: { type: 'string' },
            teamSlug: { type: 'string' },
            organizationSlug: { type: 'string' },
            start: isoUtc,
            attendee: { $ref: '#/components/schemas/CalAttendeeInput' },
            guests: {
              type: 'array',
              maxItems: 10,
              uniqueItems: true,
              items: { type: 'string', format: 'email' },
            },
            bookingFieldsResponses: {
              type: 'object',
              additionalProperties: {
                oneOf: [
                  { type: 'string' },
                  { type: 'boolean' },
                  { type: 'array', items: { type: 'string' } },
                ],
              },
            },
            metadata: {
              type: 'object',
              maxProperties: 50,
              propertyNames: { maxLength: 40 },
              additionalProperties: { type: 'string', maxLength: 500 },
            },
            lengthInMinutes: {
              type: 'integer',
              minimum: 1,
              description: 'Accepted only when equal to the event type duration in R1.',
            },
          },
          example: {
            eventTypeId: 'replace-with-event-type-id',
            start: '2026-07-24T15:00:00Z',
            attendee: {
              name: 'Test Customer',
              email: 'customer@example.com',
              timeZone: 'America/Bogota',
              language: 'es',
              phoneNumber: '+573000000000',
            },
            guests: ['guest@example.com'],
            metadata: { source: 'flow-studio' },
            bookingFieldsResponses: { notes: 'Created from an automation' },
          },
        }),
        responses: {
          '201': {
            description: 'Booking created, or the original booking returned for an idempotent retry.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/BookingSuccess' },
              },
            },
          },
          '400': errorResponse('Invalid input, timezone, or API version.'),
          '401': errorResponse('Missing or invalid API key.'),
          '403': errorResponse('API key lacks bookings:write.'),
          '404': errorResponse('Event type is absent, cross-tenant, or outside the key allowlist.'),
          '409': errorResponse('Slot collision or idempotency-key mismatch.'),
          '422': errorResponse('Invalid booking fields or recognized unsupported Cal variant.'),
        },
      },
    },
    '/health': {
      get: {
        summary: 'Liveness + DB probe',
        responses: { '200': { description: 'ok | degraded' } },
      },
    },
    '/v1/availability': {
      get: {
        summary: 'Public availability (slots, seat-aware)',
        parameters: ['accountCode', 'handle', 'slug', 'from', 'to', 'timeZone'].map((name) => ({
          name,
          in: 'query',
          required: name !== 'to' && name !== 'timeZone',
          schema: { type: 'string' },
        })),
        responses: { '200': { description: 'Availability with slots[{startUtc,spotsLeft?,capacity?}]' } },
      },
    },
    '/v1/reservations': {
      post: {
        summary: 'Place a 10-minute hold on a slot',
        requestBody: jsonBody({
          type: 'object',
          required: ['accountCode', 'handle', 'slug', 'startUtc'],
          properties: {
            accountCode: { type: 'string' },
            handle: { type: 'string' },
            slug: { type: 'string' },
            startUtc: isoUtc,
          },
        }),
        responses: {
          '201': { description: '{reservationUid,expiresAt}' },
          '400': { description: 'INVALID_SLOT' },
          '429': { description: 'RATE_LIMITED' },
        },
      },
    },
    '/v1/bookings': {
      post: {
        summary: 'Create a booking (consumes a hold; intake-validated)',
        requestBody: jsonBody({
          type: 'object',
          required: ['accountCode', 'handle', 'slug', 'startUtc', 'attendee'],
          properties: {
            accountCode: { type: 'string' },
            handle: { type: 'string' },
            slug: { type: 'string' },
            startUtc: isoUtc,
            attendee: { $ref: '#/components/schemas/Attendee' },
            answers: {
              type: 'object',
              additionalProperties: true,
              description: "Answers to the event type's custom intake fields (required ones enforced).",
            },
            reservationUid: { type: 'string', description: 'Consume a held reservation (slot hold).' },
            idempotencyKey: { type: 'string', description: 'Dedupes retries.' },
          },
        }),
        responses: {
          '201': { description: 'BookingView (+ one-time manageUrl)' },
          '409': { description: 'SLOT_TAKEN' },
          '410': { description: 'RESERVATION_EXPIRED' },
          '400': { description: 'INTAKE_INVALID' },
        },
      },
    },
    '/v1/bookings/{uid}': {
      get: {
        summary: 'Manage view (attendee self-service; token via X-Manage-Token header, ?token=, or body)',
        parameters: [{ name: 'uid', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'BookingView' }, '403': { description: 'Invalid manage link' } },
      },
    },
    '/v1/bookings/{uid}/cancel': {
      post: {
        summary: 'Attendee cancel (manage token; pending and accepted both cancel; idempotent)',
        parameters: [{ name: 'uid', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: jsonBody(
          {
            type: 'object',
            properties: {
              token: { type: 'string', description: 'Manage token (alternative to header/query).' },
              reason: { type: 'string' },
            },
          },
          false,
        ),
        responses: {
          '200': { description: '{uid,status:"cancelled"}' },
          '403': { description: 'Invalid manage link' },
          '410': { description: 'Not cancellable (declined)' },
        },
      },
    },
    '/v1/bookings/{uid}/reschedule': {
      post: {
        summary: 'Attendee reschedule (manage token rotates on success)',
        parameters: [{ name: 'uid', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: jsonBody({
          type: 'object',
          required: ['newStartUtc'],
          properties: {
            newStartUtc: isoUtc,
            token: { type: 'string', description: 'Manage token (alternative to header/query).' },
          },
        }),
        responses: {
          '200': { description: 'BookingView (new manageUrl)' },
          '403': { description: 'Invalid manage link' },
          '409': { description: 'SLOT_TAKEN' },
        },
      },
    },
    '/v1/machine/availability': {
      get: {
        summary: 'Agent availability (60-day cap)',
        security: [{ apiKey: [] }],
        parameters: ['eventTypeId', 'handle', 'slug', 'from', 'to', 'timeZone'].map((name) => ({
          name,
          in: 'query',
          required: name === 'from',
          schema: { type: 'string' },
          description: name === 'eventTypeId' ? 'Address by id (or use handle+slug).' : undefined,
        })),
        responses: { '200': { description: 'Availability' }, '403': { description: 'out-of-scope' } },
      },
    },
    '/v1/machine/bookings': {
      post: {
        summary: 'Agent create booking (attendees[]; Idempotency-Key)',
        security: [{ apiKey: [] }],
        parameters: [
          { name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string' } },
        ],
        requestBody: jsonBody({
          type: 'object',
          required: ['startUtc', 'attendees'],
          properties: {
            eventTypeId: { type: 'string', description: 'Address by id (or use handle+slug).' },
            handle: { type: 'string' },
            slug: { type: 'string' },
            startUtc: isoUtc,
            attendees: { type: 'array', minItems: 1, items: { $ref: '#/components/schemas/Attendee' } },
            answers: { type: 'object', additionalProperties: true },
          },
        }),
        responses: { '201': { description: '{uid,status,startUtc,endUtc}' } },
      },
      get: {
        summary: 'Agent list bookings',
        security: [{ apiKey: [] }],
        parameters: ['status', 'from', 'to', 'cursor', 'limit'].map((name) => ({
          name,
          in: 'query',
          required: false,
          schema: { type: 'string' },
        })),
        responses: { '200': { description: '{items,nextCursor}' } },
      },
    },
    '/v1/machine/bookings/{uid}': {
      patch: {
        summary: 'Agent reschedule',
        security: [{ apiKey: [] }],
        parameters: [
          { name: 'uid', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string' } },
        ],
        requestBody: jsonBody({
          type: 'object',
          required: ['newStartUtc'],
          properties: { newStartUtc: isoUtc },
        }),
        responses: { '200': { description: 'rescheduled' }, '403': { description: 'out-of-scope' } },
      },
    },
    '/v1/machine/bookings/{uid}/cancel': {
      post: {
        summary: 'Agent cancel (pending and accepted both cancel; idempotent on retry)',
        security: [{ apiKey: [] }],
        parameters: [
          { name: 'uid', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string' } },
        ],
        requestBody: jsonBody(
          { type: 'object', properties: { reason: { type: 'string' } } },
          false,
        ),
        responses: {
          '200': { description: '{uid,status:"cancelled"} (retries return alreadyApplied)' },
          '403': { description: 'out-of-scope' },
          '410': { description: 'Not cancellable (declined)' },
        },
      },
    },
    '/v1/machine/bookings/{uid}/attendees': {
      post: {
        summary: 'Agent add attendee to an existing booking (group/guest use)',
        security: [{ apiKey: [] }],
        parameters: [{ name: 'uid', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: jsonBody({
          type: 'object',
          required: ['attendee'],
          properties: { attendee: { $ref: '#/components/schemas/Attendee' } },
        }),
        responses: { '201': { description: 'attendee added' }, '403': { description: 'out-of-scope' } },
      },
    },
  },
} as const;
