/**
 * Hand-curated OpenAPI 3.1 description of the scheduling API's integrator-facing
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
    timeZone: {
      type: 'string',
      description: 'IANA zone (validated); defaults to UTC on the machine surface.',
    },
    notes: { type: 'string', maxLength: 2000 },
    phone: { type: 'string', maxLength: 32, description: 'E.164 preferred.' },
    language: {
      type: 'string',
      enum: ['en', 'es'],
      description: 'Notification/.ics language.',
    },
  },
} as const;

const isoUtc = {
  type: 'string',
  format: 'date-time',
  description: 'ISO-8601 UTC instant.',
} as const;

/**
 * The one-off invite-link header (#110), shared by every route that honours it.
 *
 * A HEADER rather than a query parameter because it is a credential: a query
 * string lands in access logs and in `Referer` on every outbound click. Always
 * optional — absent, the route behaves exactly as it did before this existed.
 */
const oneOffHeaderParam = {
  name: 'X-One-Off-Token',
  in: 'header',
  required: false,
  schema: { type: 'string' },
  description:
    'A one-off invite-link token (see GET /v1/public/one-off/{token}). Presenting a live ' +
    'one lets this request reach the single event type that token opens, including one ' +
    'hidden from the public booking page; a booking made with it consumes it. Ignored on ' +
    'API-key writes, which are not subject to the grant.',
};

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

const idempotencyParameter = (example: string) => ({
  name: 'Idempotency-Key',
  in: 'header',
  required: false,
  schema: { type: 'string', minLength: 1, maxLength: 128 },
  description:
    'Stable operation key. Same key/body returns the original response; same key/different body returns 409.',
  example,
});

const idempotencyExtension = {
  extension: true,
  reuse: 'same request returns original response without repeated side effects',
  mismatch: '409 IDEMPOTENCY_KEY_REUSED',
} as const;

const eventTypeId = {
  oneOf: [
    { type: 'integer', minimum: 0 },
    { type: 'string', minLength: 1 },
  ],
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

// --- The introduction (info.description) ------------------------------------

/**
 * The `cal-api-version` each /v2 operation requires, as the introduction lists
 * them. openapi.spec.ts asserts this table equals the enums the paths declare,
 * so the two cannot drift.
 */
export const CAL_VERSION_PINS = [
  ['GET /v2/event-types', '2024-06-14'],
  ['GET /v2/slots', '2024-09-04'],
  ['POST /v2/bookings', '2026-02-25'],
  ['GET /v2/bookings/{uid}', '2026-02-25'],
  ['POST /v2/bookings/{uid}/reschedule', '2026-02-25'],
  ['POST /v2/bookings/{uid}/cancel', '2026-02-25'],
  ['POST /v2/bookings/{uid}/guests', '2024-08-13'],
] as const;

/** The addresses the introduction names, each from this deployment's configuration. */
export type ApiDocLinks = {
  /** This API's public base URL (API_PUBLIC_URL). */
  apiUrl?: string;
  /** The dashboard page where API keys are created. */
  keysUrl?: string;
  /** The MCP endpoint people paste into an agent (MCP_PUBLIC_URL). */
  mcpUrl?: string;
  /** The developer guides (DEVELOPER_DOCS_URL). */
  docsUrl?: string;
};

/** A configured address made safe inside a markdown link destination. */
const mdUrl = (url: string): string => url.replace(/[()\s]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);

/**
 * The introduction the API reference shows above the operations (markdown),
 * written for the people who call the API. Every address comes from the
 * deployment's configuration; one that is unset is left out or described,
 * never filled in with someone else's host.
 */
export function apiIntroduction(links: ApiDocLinks = {}): string {
  const { apiUrl, keysUrl, mcpUrl, docsUrl } = links;
  const base = apiUrl ? `\`${apiUrl}\`` : 'the address this API is served at (the `servers` entry of this document)';
  const keys = keysUrl ? `on the [API keys](${mdUrl(keysUrl)}) page of your dashboard` : 'on the API keys page of your dashboard';
  const more = [
    mcpUrl && `AI assistants and agents can book through the MCP server at \`${mcpUrl}\`, on the same engine.`,
    docsUrl && `Step-by-step guides with examples: [developer docs](${mdUrl(docsUrl)}).`,
  ].filter(Boolean);
  return [
    'Book meetings from your own systems: list event types, read open times, then create, reschedule and cancel bookings. ' +
      'The API runs on the same engine as the booking page, so it offers the same times and keeps the same rules.',
    `**Base URL:** ${base}`,
    '## Authentication',
    'Send an API key in the `Authorization` header of every request:',
    '```http\nAuthorization: Bearer dcl_<prefix>_<secret>\n```',
    `Create a key ${keys}. A key reaches only what its scopes allow. ` +
      'Call the API from your server, never from a web page, and never put a key in a URL.',
    '## Two APIs',
    '- **REST API**, under `/v1/machine`: read open times, then book, list, reschedule and cancel. The simplest start for a new integration.\n' +
      "- **Cal.com-compatible API**, under `/v2`: the paths, headers and field names of Cal.com's API v2, so a tool that already speaks Cal.com works with your key. " +
      'It adds one extension: open times across several of your connected calendars (`POST /v2/calendars/availability`).',
    'Both share the same booking engine, so they offer the same times.',
    '## Version header',
    'Each `/v2` operation below needs a `cal-api-version` header with exactly this value. ' +
      'A missing or different value answers `400 UNSUPPORTED_API_VERSION`. The calendar endpoints and `/v1/machine` take no version header.',
    ['| Operation | `cal-api-version` |', '| --- | --- |', ...CAL_VERSION_PINS.map(([op, v]) => `| \`${op}\` | \`${v}\` |`)].join('\n'),
    '## Safe retries',
    'Booking, rescheduling and cancelling accept an `Idempotency-Key` header, and so does adding guests on `/v2`. ' +
      'Use one key per real-world action, built from something stable on your side, of up to 128 characters. ' +
      'Sending the same key again returns the original result instead of acting twice. ' +
      'On `/v2`, the same key with a different body answers `409 IDEMPOTENCY_KEY_REUSED`.',
    ...(more.length ? ['## More', ...more] : []),
  ].join('\n\n');
}

export const openapiSpec = {
  openapi: '3.1.0',
  info: {
    // The served title names the deployment's product, and the served
    // introduction its addresses (`openapiFor`).
    title: 'Calendars API',
    version: '2.0.0',
    description: apiIntroduction(),
    license: { name: 'MIT' },
  },
  // Relative on purpose: the served document names this deployment's address
  // through `openapiFor` (API_PUBLIC_URL), never a hardcoded host.
  servers: [{ url: '/', description: 'This deployment' }],
  // The reference's sidebar groups, in this order. Display only: renaming one
  // changes no path, schema or operation id.
  tags: [
    {
      name: 'REST API',
      description:
        'Read open times, then book, list, reschedule and cancel bookings with an API key. The simplest start for a new integration.',
    },
    {
      name: 'Cal.com-compatible API',
      description:
        "The paths, headers and field names of Cal.com's API v2, so a tool that already speaks Cal.com works with your key. Each operation needs its `cal-api-version` header.",
    },
    {
      name: 'Calendar availability',
      description: 'An addition to the Cal.com shape: open times across up to 100 of your connected calendars in one call.',
    },
    {
      name: 'Booking page',
      description:
        "The public endpoints behind the booking page and the invitee's manage link. They take no API key; a manage link's token reaches only its own booking.",
    },
    {
      name: 'Health',
      description: 'Whether this deployment and its database are up.',
    },
  ],
  'x-dapta-compatibility': {
    implemented: [
      'GET /v2/calendars',
      'POST /v2/calendars/availability',
      'GET /v2/event-types',
      'GET /v2/slots',
      'POST /v2/bookings',
      'GET /v2/bookings/{uid}',
      'POST /v2/bookings/{uid}/reschedule',
      'POST /v2/bookings/{uid}/guests',
      'POST /v2/bookings/{uid}/cancel',
    ],
    deferred: ['booking list', 'slot reservations', 'selected/destination calendar mutations'],
    unsupportedVariants: [
      'recurrence',
      'seats',
      'instant meetings',
      'routing',
      'variable duration',
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
      apiKey: {
        type: 'http',
        scheme: 'bearer',
        description: 'dcl_ API key (Authorization: Bearer …).',
      },
      // Host/dashboard surface — pluggable AuthProvider (session/JWT in prod).
      hostSession: {
        type: 'apiKey',
        in: 'header',
        name: 'authorization',
        description: 'Host session (AuthProvider).',
      },
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
                  'CALENDAR_READ_ONLY',
                  'CALENDAR_READ_FORBIDDEN',
                  'PROVIDER_UNAVAILABLE',
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
            description: 'Only en and es are supported. Other Cal.com locales return FEATURE_NOT_SUPPORTED.',
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
          status: {
            type: 'string',
            enum: ['accepted', 'pending', 'cancelled', 'rejected'],
          },
          start: isoUtc,
          end: isoUtc,
          duration: { type: 'integer' },
          eventTypeId: { type: 'integer' },
          eventType: {
            type: 'object',
            required: ['id', 'slug'],
            properties: { id: { type: 'integer' }, slug: { type: 'string' } },
          },
          hosts: {
            type: 'array',
            items: { type: 'object', additionalProperties: true },
          },
          attendees: {
            type: 'array',
            items: { type: 'object', additionalProperties: true },
          },
          guests: { type: 'array', items: { type: 'string', format: 'email' } },
          metadata: {
            type: 'object',
            additionalProperties: { type: 'string' },
          },
          bookingFieldsResponses: {
            type: 'object',
            additionalProperties: true,
          },
          location: { type: ['string', 'null'] },
          meetingUrl: { type: ['string', 'null'] },
          destinationCalendarId: { type: ['string', 'null'] },
          cancellationReason: { type: ['string', 'null'] },
          cancelledByEmail: { type: ['string', 'null'] },
          reschedulingReason: { type: ['string', 'null'] },
          rescheduledByEmail: { type: ['string', 'null'] },
          rescheduledFromUid: { type: ['string', 'null'] },
          rescheduledToUid: { type: ['string', 'null'] },
          icsUid: { type: 'string' },
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
      EventType: {
        type: 'object',
        required: ['id', 'lengthInMinutes', 'title', 'slug', 'bookingFields', 'locations', 'type'],
        properties: {
          id: { type: 'integer' },
          daptaId: {
            type: 'string',
            description: 'Native stable Dapta identifier.',
          },
          lengthInMinutes: { type: 'integer' },
          title: { type: 'string' },
          slug: { type: 'string' },
          description: { type: ['string', 'null'] },
          locations: { type: 'array', items: {} },
          bookingFields: {
            type: 'array',
            items: { type: 'object', additionalProperties: true },
          },
          type: { type: 'string', enum: ['personal', 'team'] },
          schedulingType: {
            type: ['string', 'null'],
            enum: ['round_robin', 'collective', 'fixed_round_robin', null],
          },
          username: { type: ['string', 'null'] },
          team: {
            oneOf: [
              { type: 'null' },
              {
                type: 'object',
                required: ['id', 'slug', 'name'],
                properties: {
                  id: { type: 'integer' },
                  daptaId: { type: 'string' },
                  slug: { type: 'string' },
                  name: { type: 'string' },
                },
              },
            ],
          },
        },
      },
      Calendar: {
        type: 'object',
        required: [
          'id',
          'externalId',
          'credentialId',
          'integration',
          'provider',
          'name',
          'primary',
          'readOnly',
          'isSelected',
          'accessRole',
          'source',
          'capabilities',
          'syncStatus',
        ],
        properties: {
          id: {
            type: 'string',
            description: 'Tenant-scoped Dapta calendar ID used by batch availability.',
          },
          externalId: { type: 'string' },
          credentialId: { type: 'integer' },
          delegationCredentialId: { type: ['string', 'null'] },
          integration: { type: 'string' },
          provider: { type: 'string' },
          name: { type: 'string' },
          email: { type: ['string', 'null'] },
          primary: { type: 'boolean' },
          readOnly: { type: 'boolean' },
          isSelected: { type: 'boolean' },
          accessRole: {
            type: 'string',
            enum: ['owner', 'writer', 'reader', 'freeBusyReader', 'none'],
          },
          source: {
            type: 'string',
            enum: ['primary', 'owned', 'shared', 'subscribed', 'delegated'],
          },
          capabilities: {
            type: 'object',
            required: ['canRead', 'canReadFreeBusy', 'canCreate', 'canUpdate', 'canDelete'],
            properties: {
              canRead: { type: 'boolean' },
              canReadFreeBusy: { type: 'boolean' },
              canCreate: { type: 'boolean' },
              canUpdate: { type: 'boolean' },
              canDelete: { type: 'boolean' },
            },
          },
          syncStatus: { type: 'string', enum: ['healthy', 'stale', 'error'] },
          lastSyncedAt: { ...isoUtc, type: ['string', 'null'] },
        },
      },
      CalendarAvailabilityInput: {
        type: 'object',
        additionalProperties: false,
        required: ['calendarIds', 'from', 'to', 'timeZone', 'durationMinutes', 'mode'],
        properties: {
          calendarIds: {
            type: 'array',
            minItems: 1,
            maxItems: 100,
            uniqueItems: true,
            items: { type: 'string' },
          },
          from: isoUtc,
          to: isoUtc,
          timeZone: { type: 'string', example: 'America/Bogota' },
          durationMinutes: { type: 'integer', minimum: 1, maximum: 1440 },
          intervalMinutes: { type: 'integer', minimum: 1, maximum: 1440 },
          bufferBeforeMinutes: {
            type: 'integer',
            minimum: 0,
            maximum: 1440,
            default: 0,
          },
          bufferAfterMinutes: {
            type: 'integer',
            minimum: 0,
            maximum: 1440,
            default: 0,
          },
          mode: {
            type: 'string',
            enum: ['perCalendar', 'allAvailable', 'anyAvailable'],
          },
        },
      },
      GuestInput: {
        type: 'object',
        additionalProperties: false,
        required: ['email'],
        properties: {
          email: { type: 'string', format: 'email' },
          name: { type: 'string', maxLength: 200 },
          timeZone: { type: 'string' },
        },
      },
    },
  },
  paths: {
    '/v2/slots': {
      get: {
        tags: ['Cal.com-compatible API'],
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
          {
            name: 'eventTypeSlug',
            in: 'query',
            required: false,
            schema: { type: 'string' },
          },
          {
            name: 'username',
            in: 'query',
            required: false,
            schema: { type: 'string' },
          },
          {
            name: 'teamSlug',
            in: 'query',
            required: false,
            schema: { type: 'string' },
          },
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
          {
            name: 'duration',
            in: 'query',
            required: false,
            schema: { type: 'integer', minimum: 1 },
          },
          {
            name: 'format',
            in: 'query',
            required: false,
            schema: {
              type: 'string',
              enum: ['time', 'range'],
              default: 'time',
            },
          },
          {
            name: 'bookingUidToReschedule',
            in: 'query',
            required: false,
            schema: { type: 'string' },
            description: 'Recognized but not supported: returns 422.',
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
          '422': errorResponse('A recognized Cal.com variant that is not supported.'),
        },
      },
    },
    '/v2/bookings': {
      post: {
        tags: ['Cal.com-compatible API'],
        operationId: 'createV2Booking',
        summary: 'Create a personal or team booking',
        description:
          'Uses the current 2026-02-25 request and response names. All guests are persisted as booking attendees. Idempotency-Key is an addition to the Cal.com shape: send one so a retry never books twice.',
        security: [{ dclBearer: [] }],
        parameters: [calVersion('2026-02-25'), idempotencyParameter('crm-lead-4821:create-booking')],
        'x-dapta-idempotency': idempotencyExtension,
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
              description: 'Accepted only when equal to the event type duration.',
            },
            destinationCalendarId: {
              type: 'string',
              description:
                'Dapta calendar discovery ID. Supported for personal events; read-only calendars return 403.',
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
            metadata: { source: 'crm' },
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
    '/v2/bookings/{uid}': {
      get: {
        tags: ['Cal.com-compatible API'],
        operationId: 'getV2Booking',
        summary: 'Get a booking',
        security: [{ dclBearer: [] }],
        parameters: [
          calVersion('2026-02-25'),
          {
            name: 'uid',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': {
            description: 'Current booking state.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/BookingSuccess' },
              },
            },
          },
          '400': errorResponse('Unsupported API version.'),
          '401': errorResponse('Missing or invalid API key.'),
          '403': errorResponse('API key lacks bookings:read.'),
          '404': errorResponse('Booking is absent, cross-tenant, or outside the key allowlist.'),
        },
      },
    },
    '/v2/bookings/{uid}/cancel': {
      post: {
        tags: ['Cal.com-compatible API'],
        operationId: 'cancelV2Booking',
        summary: 'Cancel a booking',
        description: 'The booking keeps its UID. A retry returns the same UID and response.',
        security: [{ dclBearer: [] }],
        parameters: [
          calVersion('2026-02-25'),
          idempotencyParameter('crm-lead-4821:cancel-booking'),
          {
            name: 'uid',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        'x-dapta-idempotency': idempotencyExtension,
        requestBody: jsonBody(
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              cancellationReason: { type: 'string', maxLength: 1000 },
              cancelSubsequentBookings: {
                type: 'boolean',
                const: false,
                description: 'Recurring bookings are not implemented.',
              },
            },
          },
          false,
        ),
        responses: {
          '200': {
            description: 'Cancelled booking; retry returns the same UID and response.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/BookingSuccess' },
              },
            },
          },
          '400': errorResponse('Invalid body or unsupported API version.'),
          '401': errorResponse('Missing or invalid API key.'),
          '403': errorResponse('API key lacks bookings:write.'),
          '404': errorResponse('Booking is absent, cross-tenant, or outside the key allowlist.'),
          '409': errorResponse('Idempotency-Key was reused with a different request.'),
          '422': errorResponse('Recurring/seated cancellation is not implemented.'),
        },
      },
    },
    '/v2/bookings/{uid}/reschedule': {
      post: {
        tags: ['Cal.com-compatible API'],
        operationId: 'rescheduleV2Booking',
        summary: 'Reschedule a booking',
        description: 'The moved booking gets a new UID; the response links the old and the new one.',
        security: [{ dclBearer: [] }],
        parameters: [
          calVersion('2026-02-25'),
          idempotencyParameter('crm-lead-4821:reschedule-booking'),
          {
            name: 'uid',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        'x-dapta-idempotency': idempotencyExtension,
        requestBody: jsonBody({
          type: 'object',
          additionalProperties: false,
          required: ['start'],
          properties: {
            start: isoUtc,
            rescheduledBy: { type: 'string', format: 'email' },
            reschedulingReason: { type: 'string', maxLength: 1000 },
          },
          example: {
            start: '2026-07-25T16:00:00Z',
            rescheduledBy: 'customer@example.com',
            reschedulingReason: 'Customer requested a later time',
          },
        }),
        responses: {
          '201': {
            description: 'New booking UID with rescheduledFromUid; the old booking exposes rescheduledToUid.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/BookingSuccess' },
              },
            },
          },
          '400': errorResponse('Invalid target or unsupported API version.'),
          '401': errorResponse('Missing or invalid API key.'),
          '403': errorResponse('API key lacks bookings:write.'),
          '404': errorResponse('Booking is absent, cross-tenant, or outside the key allowlist.'),
          '409': errorResponse('Target slot is taken or Idempotency-Key mismatched.'),
          '422': errorResponse('Seats and recurrence are not implemented.'),
        },
      },
    },
    '/v2/bookings/{uid}/guests': {
      post: {
        tags: ['Cal.com-compatible API'],
        operationId: 'addV2BookingGuests',
        summary: 'Add guests to a booking',
        security: [{ dclBearer: [] }],
        parameters: [
          calVersion('2024-08-13'),
          idempotencyParameter('crm-lead-4821:add-guests'),
          {
            name: 'uid',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        'x-dapta-idempotency': idempotencyExtension,
        requestBody: jsonBody({
          type: 'object',
          additionalProperties: false,
          required: ['guests'],
          properties: {
            guests: {
              type: 'array',
              minItems: 1,
              maxItems: 10,
              items: { $ref: '#/components/schemas/GuestInput' },
            },
          },
          example: {
            guests: [
              {
                email: 'guest@example.com',
                name: 'Guest Customer',
                timeZone: 'America/Bogota',
              },
            ],
          },
        }),
        responses: {
          '200': {
            description: 'Updated booking. Existing guest emails are not duplicated.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/BookingSuccess' },
              },
            },
          },
          '400': errorResponse('Invalid guests or unsupported API version.'),
          '401': errorResponse('Missing or invalid API key.'),
          '403': errorResponse('API key lacks bookings:write.'),
          '404': errorResponse('Booking is absent, cross-tenant, or outside the key allowlist.'),
          '409': errorResponse('Idempotency-Key was reused with a different request.'),
          '422': errorResponse(
            'LIMIT_EXCEEDED: the booking would hold more than 30 people in all, attendees and guests each counted once (or its event seats, when more).',
          ),
        },
      },
    },
    '/v2/event-types': {
      get: {
        tags: ['Cal.com-compatible API'],
        operationId: 'getV2EventTypes',
        summary: 'List event types',
        security: [{ dclBearer: [] }],
        parameters: [
          calVersion('2024-06-14'),
          {
            name: 'username',
            in: 'query',
            required: false,
            schema: { type: 'string' },
          },
          {
            name: 'eventSlug',
            in: 'query',
            required: false,
            schema: { type: 'string' },
          },
          {
            name: 'teamSlug',
            in: 'query',
            required: false,
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': {
            description: 'Tenant- and key-scoped event types.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['status', 'data'],
                  properties: {
                    status: { type: 'string', const: 'success' },
                    data: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/EventType' },
                    },
                  },
                },
              },
            },
          },
          '400': errorResponse('Unsupported API version.'),
          '401': errorResponse('Missing or invalid API key.'),
          '403': errorResponse('API key lacks event-types:read.'),
        },
      },
    },
    '/v2/calendars': {
      get: {
        tags: ['Cal.com-compatible API'],
        operationId: 'getV2Calendars',
        summary: 'List connected calendars',
        security: [{ dclBearer: [] }],
        responses: {
          '200': {
            description: 'Cal-shaped connected calendar groups plus Dapta capability fields.',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['status', 'data'],
                  properties: {
                    status: { type: 'string', const: 'success' },
                    data: {
                      type: 'object',
                      required: ['connectedCalendars', 'destinationCalendar', 'failures'],
                      properties: {
                        connectedCalendars: {
                          type: 'array',
                          items: { type: 'object' },
                        },
                        destinationCalendar: {
                          oneOf: [{ $ref: '#/components/schemas/Calendar' }, { type: 'null' }],
                        },
                        failures: { type: 'array', items: { type: 'object' } },
                      },
                    },
                  },
                },
              },
            },
          },
          '401': errorResponse('Missing or invalid API key.'),
          '403': errorResponse('API key lacks calendars:read.'),
          '503': errorResponse('Calendar provider is unavailable and no cached discovery data exists.'),
        },
      },
    },
    '/v2/calendars/availability': {
      post: {
        tags: ['Calendar availability'],
        operationId: 'getV2CalendarAvailability',
        summary: 'Get open times across calendars',
        description:
          'One call for one to 100 calendars from GET /v2/calendars. Every requested calendar is either represented in results or in failures; provider errors are never silently omitted.',
        security: [{ dclBearer: [] }],
        requestBody: jsonBody({
          $ref: '#/components/schemas/CalendarAvailabilityInput',
          example: {
            calendarIds: ['cal_replace_me'],
            from: '2026-07-24T00:00:00-05:00',
            to: '2026-07-31T23:59:59-05:00',
            timeZone: 'America/Bogota',
            durationMinutes: 30,
            intervalMinutes: 30,
            bufferBeforeMinutes: 0,
            bufferAfterMinutes: 0,
            mode: 'perCalendar',
          },
        }),
        responses: {
          '200': {
            description: 'Normalized slots, explicit partial flag, and per-calendar failures.',
            content: {
              'application/json': {
                schema: { type: 'object', additionalProperties: true },
              },
            },
          },
          '400': errorResponse('Invalid range, timezone, calendar count, or body.'),
          '401': errorResponse('Missing or invalid API key.'),
          '403': errorResponse('API key lacks calendars:read or all calendars forbid free/busy.'),
          '404': errorResponse('A calendar ID is absent or belongs to another tenant.'),
          '503': errorResponse('The calendar provider is unavailable for every requested calendar.'),
        },
      },
    },
    '/health': {
      get: {
        tags: ['Health'],
        summary: 'Health check',
        description: 'Liveness plus a database probe. Answers 200 even when the database is down, with `db: "down"`.',
        responses: { '200': { description: 'ok | degraded' } },
      },
    },
    '/v1/availability': {
      get: {
        tags: ['Booking page'],
        summary: 'Get open times of an event',
        description: 'The times a public booking page offers. On a group event each slot carries the seats left.',
        parameters: [
          ...['accountCode', 'handle', 'slug', 'from', 'to', 'timeZone'].map((name) => ({
            name,
            in: 'query',
            required: name !== 'to' && name !== 'timeZone',
            schema: { type: 'string' },
          })),
          oneOffHeaderParam,
        ],
        responses: {
          '200': {
            description: 'Availability with slots[{startUtc,spotsLeft?,capacity?}]',
          },
        },
      },
    },
    '/v1/public/teams/{accountCode}/{teamSlug}/availability': {
      get: {
        tags: ['Booking page'],
        summary: 'Get open times of a team event',
        description:
          'Round-robin and collective team events: the team counterpart to GET /v1/availability. The window is capped at ' +
          '60 days from `from`: a wider range is clamped, not rejected. `from` and ' +
          '`to` must be ISO-8601 instants with an offset.',
        parameters: [
          { name: 'accountCode', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'teamSlug', in: 'path', required: true, schema: { type: 'string' } },
          ...['slug', 'from', 'to', 'timeZone'].map((name) => ({
            name,
            in: 'query',
            required: name !== 'timeZone',
            schema: { type: 'string' },
          })),
          oneOffHeaderParam,
        ],
        responses: {
          '200': { description: 'Availability with slots[{startUtc}]' },
          '400': { description: 'BAD_REQUEST (missing slug, or an unparseable from/to)' },
          '404': { description: 'NOT_FOUND (no such team event)' },
          '429': { description: 'RATE_LIMITED' },
        },
      },
    },
    '/v1/public/one-off/{token}': {
      get: {
        tags: ['Booking page'],
        summary: 'Resolve a one-off link',
        description:
          'A one-off invite link is a grant a host mints over an event type they already ' +
          'have: it books that event once and then stops working. This answers WHERE the ' +
          'token points and nothing else — no host name, no event title, and no indication ' +
          'of what other links exist. Present the token on the availability, reservation ' +
          'and booking routes (see the X-One-Off-Token header) to read and book the event ' +
          'it opens, including one hidden from the public booking page. ' +
          'Rate-limited per IP like every public route.',
        parameters: [
          {
            name: 'token',
            in: 'path',
            required: true,
            schema: { type: 'string' },
            description: '43-character base64url token, as minted by the host.',
          },
        ],
        responses: {
          '200': {
            description:
              'The booking target: {kind:"personal",accountCode,handle,slug} or ' +
              '{kind:"team",accountCode,teamSlug,slug}.',
          },
          '410': {
            description:
              'ONE_OFF_GONE — the link was real and is spent or revoked. A booking made ' +
              'against it (pending included) consumes it permanently; cancelling that ' +
              'booking does NOT bring it back.',
          },
          '404': {
            description:
              'The token names nothing. Deliberately indistinguishable from any other ' +
              'missing route.',
          },
          '429': { description: 'RATE_LIMITED' },
        },
      },
    },
    '/v1/reservations': {
      post: {
        tags: ['Booking page'],
        summary: 'Hold a time for 10 minutes',
        // One-off invite links (#110). Optional everywhere it appears: absent,
        // nothing about the route changes. Present and live, it lets THIS
        // request see the one hidden event type that token opens.
        parameters: [oneOffHeaderParam],

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
    '/v1/reservations/release': {
      post: {
        tags: ['Booking page'],
        summary: 'Release a held time',
        description:
          'Releases a hold placed by POST /v1/reservations so the slot is offered ' +
          'to other visitors again, rather than waiting out its ten-minute TTL. ' +
          'The reservation uid is the authorisation — releasing a hold you do not ' +
          'hold, one that already expired, or one a booking already consumed all ' +
          'answer the same 200, so this is never a way to learn whether a hold exists.',
        requestBody: jsonBody({
          type: 'object',
          required: ['reservationUid'],
          properties: {
            reservationUid: {
              type: 'string',
              description: 'The uid returned by POST /v1/reservations.',
            },
          },
        }),
        responses: {
          '200': { description: '{released:true} — always, when the body parses' },
          '400': { description: 'BAD_REQUEST (no reservationUid)' },
          '429': { description: 'RATE_LIMITED' },
        },
      },
    },
    '/v1/bookings': {
      post: {
        tags: ['Booking page'],
        summary: 'Book a held time',
        description: 'Consumes the hold. The event\'s required booking questions must be answered in `answers`.',
        // One-off invite links (#110). Optional everywhere it appears: absent,
        // nothing about the route changes. Present and live, it lets THIS
        // request see the one hidden event type that token opens.
        parameters: [oneOffHeaderParam],

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
            locale: {
              type: 'string',
              enum: ['en', 'es'],
              description:
                "The language of the page the visitor booked on: the invitee's emails are " +
                "written in it (attendee.language, when given, wins). Absent: the host's language.",
            },
            reservationUid: {
              type: 'string',
              description:
                'Consume a held reservation (slot hold) from POST /v1/reservations. It must ' +
                'be the hold on this event (handle + slug) at this startUtc; any other, or ' +
                'one past its ten minutes, answers 410 RESERVATION_EXPIRED. A matching hold ' +
                'stands in for the offered-time check: the time was checked (hours, interval, ' +
                'minimum notice) when the hold was granted.',
            },
            // No `idempotencyKey` (#104): this route is unauthenticated and the
            // server drops the field. Retry dedupe is an API-key feature — the
            // machine and v2 surfaces take it as an `Idempotency-Key` header.
          },
        }),
        responses: {
          '201': { description: 'BookingView (+ one-time manageUrl)' },
          '409': { description: 'SLOT_TAKEN | DUPLICATE_BOOKING' },
          '410': {
            description:
              'RESERVATION_EXPIRED (the reservationUid names no live hold on this event at ' +
              'this startUtc), or ONE_OFF_GONE when a presented one-off invite link ' +
              'is already spent or revoked.',
          },
          '404': {
            description:
              'No such booking page — or a one-off invite token that names nothing, or ' +
              'that opens a different event type than the one being booked.',
          },
          '400': { description: 'INTAKE_INVALID' },
        },
      },
    },
    '/v1/bookings/{uid}': {
      get: {
        tags: ['Booking page'],
        summary: 'Get a booking from its manage link',
        description: 'The manage token goes in the X-Manage-Token header, the `token` query parameter or the body.',
        parameters: [
          {
            name: 'uid',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': { description: 'BookingView' },
          '403': { description: 'Invalid manage link' },
        },
      },
    },
    '/v1/bookings/{uid}/availability': {
      get: {
        tags: ['Booking page'],
        summary: 'Get times a booking can move to',
        description:
          'Needs the manage token. Scoped to the hosts the booking already has, so the picker never offers a time the reschedule refuses.',
        parameters: [
          { name: 'uid', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'from', in: 'query', required: true, schema: { type: 'string', format: 'date-time' } },
          { name: 'to', in: 'query', required: true, schema: { type: 'string', format: 'date-time' } },
          { name: 'timeZone', in: 'query', required: false, schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'AvailabilityResponse' },
          '400': { description: 'BAD_REQUEST' },
          '404': { description: 'Booking not found, or an invalid manage link' },
        },
      },
    },
    '/v1/bookings/{uid}/cancel': {
      post: {
        tags: ['Booking page'],
        summary: 'Cancel from the manage link',
        description: 'Needs the manage token. Pending and accepted bookings both cancel; a retry changes nothing.',
        parameters: [
          {
            name: 'uid',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        requestBody: jsonBody(
          {
            type: 'object',
            properties: {
              token: {
                type: 'string',
                description: 'Manage token (alternative to header/query).',
              },
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
        tags: ['Booking page'],
        summary: 'Reschedule from the manage link',
        description: 'Needs the manage token, which is replaced by a new one on success.',
        parameters: [
          {
            name: 'uid',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        requestBody: jsonBody({
          type: 'object',
          required: ['newStartUtc'],
          properties: {
            newStartUtc: isoUtc,
            token: {
              type: 'string',
              description: 'Manage token (alternative to header/query).',
            },
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
        tags: ['REST API'],
        summary: 'Get open times',
        description: 'The open times of one event. A window longer than 60 days is cut to 60 days.',
        security: [{ apiKey: [] }],
        parameters: ['eventTypeId', 'handle', 'slug', 'from', 'to', 'timeZone'].map((name) => ({
          name,
          in: 'query',
          required: name === 'from',
          schema: { type: 'string' },
          description: name === 'eventTypeId' ? 'Address by id (or use handle+slug).' : undefined,
        })),
        responses: {
          '200': { description: 'Availability' },
          '403': { description: 'out-of-scope' },
        },
      },
    },
    '/v1/machine/bookings': {
      post: {
        tags: ['REST API'],
        summary: 'Create a booking',
        description: 'Books a time for the people in `attendees`. Send an Idempotency-Key so a retry never books twice.',
        security: [{ apiKey: [] }],
        parameters: [
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: false,
            schema: { type: 'string' },
          },
        ],
        requestBody: jsonBody({
          type: 'object',
          required: ['startUtc', 'attendees'],
          properties: {
            eventTypeId: {
              type: 'string',
              description: 'Address by id (or use handle+slug).',
            },
            handle: { type: 'string' },
            slug: { type: 'string' },
            startUtc: isoUtc,
            attendees: {
              type: 'array',
              minItems: 1,
              items: { $ref: '#/components/schemas/Attendee' },
            },
            answers: { type: 'object', additionalProperties: true },
          },
        }),
        responses: { '201': { description: '{uid,status,startUtc,endUtc}' } },
      },
      get: {
        tags: ['REST API'],
        summary: 'List bookings',
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
        tags: ['REST API'],
        summary: 'Reschedule a booking',
        security: [{ apiKey: [] }],
        parameters: [
          {
            name: 'uid',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: false,
            schema: { type: 'string' },
          },
        ],
        requestBody: jsonBody({
          type: 'object',
          required: ['newStartUtc'],
          properties: { newStartUtc: isoUtc },
        }),
        responses: {
          '200': { description: 'rescheduled' },
          '403': { description: 'out-of-scope' },
        },
      },
    },
    '/v1/machine/bookings/{uid}/cancel': {
      post: {
        tags: ['REST API'],
        summary: 'Cancel a booking',
        description: 'Pending and accepted bookings both cancel; a retry changes nothing and says it was already applied.',
        security: [{ apiKey: [] }],
        parameters: [
          {
            name: 'uid',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
          {
            name: 'Idempotency-Key',
            in: 'header',
            required: false,
            schema: { type: 'string' },
          },
        ],
        requestBody: jsonBody({ type: 'object', properties: { reason: { type: 'string' } } }, false),
        responses: {
          '200': {
            description: '{uid,status:"cancelled"} (retries return alreadyApplied)',
          },
          '403': { description: 'out-of-scope' },
          '410': { description: 'Not cancellable (declined)' },
        },
      },
    },
    '/v1/machine/bookings/{uid}/attendees': {
      post: {
        tags: ['REST API'],
        summary: 'Add a guest to a booking',
        security: [{ apiKey: [] }],
        parameters: [
          {
            name: 'uid',
            in: 'path',
            required: true,
            schema: { type: 'string' },
          },
        ],
        requestBody: jsonBody({
          type: 'object',
          required: ['attendee'],
          properties: { attendee: { $ref: '#/components/schemas/Attendee' } },
        }),
        responses: {
          '201': { description: 'attendee added, or already on the booking (nothing written again)' },
          '403': { description: 'out-of-scope' },
          '410': { description: 'the booking is cancelled or otherwise no longer active' },
          '422': {
            description: 'LIMIT_EXCEEDED: the booking already holds 30 attendees and guests (or its event seats, when more)',
          },
        },
      },
    },
  },
} as const;

/**
 * The document as served: `servers` and the introduction name this deployment's
 * public addresses when they are configured (API_PUBLIC_URL and the `links`),
 * and otherwise stay relative to wherever the document is served, so a fork
 * never points at someone else's API, dashboard or guides.
 */
export function openapiFor(apiPublicUrl?: string, productName?: string, links: Omit<ApiDocLinks, 'apiUrl'> = {}) {
  // Already normalized by the env schema (`cleanPublicUrl`).
  const servers = apiPublicUrl ? [{ url: apiPublicUrl, description: 'This deployment' }] : openapiSpec.servers;
  const named = apiPublicUrl || links.keysUrl || links.mcpUrl || links.docsUrl;
  const info = {
    ...openapiSpec.info,
    ...(productName ? { title: `${productName} API` } : {}),
    ...(named ? { description: apiIntroduction({ ...links, apiUrl: apiPublicUrl }) } : {}),
  };
  return apiPublicUrl || productName || named ? { ...openapiSpec, info, servers } : openapiSpec;
}
