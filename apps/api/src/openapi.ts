/**
 * Hand-curated OpenAPI 3.1 description of Slate's integrator-facing surfaces
 * (public booking + machine/agent). Dependency-free (Slate validates with zod,
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

export const openapiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'Slate API',
    version: '1.0.0',
    description: 'Open-source scheduling — public booking + machine/agent surfaces.',
    license: { name: 'MIT' },
  },
  servers: [{ url: '/', description: 'This deployment' }],
  components: {
    securitySchemes: {
      // Machine/agent surface — API key.
      apiKey: { type: 'http', scheme: 'bearer', description: 'dcl_ API key (Authorization: Bearer …).' },
      // Host/dashboard surface — pluggable AuthProvider (session/JWT in prod).
      hostSession: { type: 'apiKey', in: 'header', name: 'authorization', description: 'Host session (AuthProvider).' },
    },
    schemas: {
      Attendee: attendeeSchema,
    },
  },
  paths: {
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
