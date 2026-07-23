# Dapta Calendars public API contract

Status: production-pilot contract
Last reviewed: 2026-07-23

The `/v2` surface is the contract for Nicolas's Flow Studio pilot. It uses Cal.com wire names only
for the implemented paths below and adds one JSON-first Dapta batch endpoint. It is not a claim of
general Cal.com parity. `/v1`, the web app, and host/admin behavior remain unchanged.

## Authentication, envelopes, and permissions

Send `Authorization: Bearer dcl_<prefix>_<secret>`. `/v2` does not accept `x-api-key`.

Every success is `{"status":"success","data":...}`. Every failure is:

```json
{
  "status": "error",
  "error": {
    "code": "RESOURCE_NOT_FOUND",
    "message": "Booking not found.",
    "details": {},
    "requestId": "req_example"
  }
}
```

Scopes are `availability:read`, `event-types:read`, `calendars:read`, `bookings:read`, and
`bookings:write`. Resource-allowlisted keys see only permitted event types and their bookings.
Absent, cross-tenant, and out-of-allowlist resources use the same non-disclosing 404.
Provider calendar capabilities are fail-closed: a calendar that does not explicitly advertise
free/busy or create permission returns a clear 403/failure entry rather than being treated writable.

## Pilot operations

| Operation                            |      Version | Notes                                                                                             |
| ------------------------------------ | -----------: | ------------------------------------------------------------------------------------------------- |
| `GET /v2/event-types`                | `2024-06-14` | Discover accessible personal/team IDs                                                             |
| `GET /v2/calendars`                  |         none | Live provider discovery with stable `cal_` IDs, capabilities, cache fallback                      |
| `POST /v2/calendars/availability`    |         none | 1–100 calendars; `perCalendar`, `allAvailable`, `anyAvailable`; explicit partial failures         |
| `GET /v2/slots`                      | `2024-09-04` | Personal/team engine slots; date-keyed Cal envelope                                               |
| `POST /v2/bookings`                  | `2026-02-25` | Personal/team create, metadata, booking fields, all creation guests                               |
| `GET /v2/bookings/{uid}`             | `2026-02-25` | Tenant/key-scoped canonical booking                                                               |
| `POST /v2/bookings/{uid}/reschedule` | `2026-02-25` | New UID; bidirectional linkage; carries attendees, guests, metadata, hosts and provider reference |
| `POST /v2/bookings/{uid}/cancel`     | `2026-02-25` | Preserves UID; safe replay                                                                        |
| `POST /v2/bookings/{uid}/guests`     | `2024-08-13` | Up to 10/request and 30 total; case-insensitive dedupe                                            |

Slots and booking create accept exactly one selector: `eventTypeId`,
`eventTypeSlug + username`, or `eventTypeSlug + teamSlug`. Numeric event-type IDs in Cal-shaped
responses are compatibility aliases; `daptaId` from discovery is the native ID.
Booking lifecycle identity is always `uid`. Canonical timestamps are `start` and `end`; the REST API
does not add `startTime`/`endTime` aliases.

`destinationCalendarId` is supported for personal create after calendar discovery. A read-only
calendar returns `403 CALENDAR_READ_ONLY`. Team assignment is dynamic, so a team destination
override returns an explicit `422 FEATURE_NOT_SUPPORTED` rather than writing to the wrong calendar.

## Mutation idempotency

Every pilot mutation accepts `Idempotency-Key` (1–128 characters). Flow Studio should use a stable
business/trigger ID plus an operation suffix.

- same tenant, API key, path, key, and request returns the stored response;
- changing the request with the same namespace returns `409 IDEMPOTENCY_KEY_REUSED`;
- create, cancel, reschedule, and guest writes have domain-level dedupe as well;
- plaintext idempotency keys are never persisted; replay records expire after 24 hours.

## Explicitly outside the pilot

Seats, recurrence, instant meetings, routing forms, PBAC, broad admin resources, webhook parity,
old Cal version adapters, reservations, list/search booking filters, routing/instant resources,
dynamic usernames, and schedule CRUD are not implemented. Recognized unsupported create variants
return `422 FEATURE_NOT_SUPPORTED`; no route should pretend these work.

The executable schema source is [`apps/api/src/openapi.ts`](apps/api/src/openapi.ts), served live at
`/openapi.json` with an interactive explorer at `/docs`.
