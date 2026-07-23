# Dapta Calendars public API contract

Status: R0 contract lock / R1 implementation
Last reviewed: 2026-07-23

The `/v2` API is Cal.com wire-compatible only for the operations marked **Implemented** below. It
uses the existing Dapta Calendars scheduling engine; `/v1` remains backward compatible.

## R1 implemented surface

| Operation           |      Version | Status      | Contract                                                                                                                                                               |
| ------------------- | -----------: | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v2/slots`     | `2024-09-04` | Implemented | `eventTypeId`, personal slug, or team slug selector; timezone; date-keyed slots; `format=range`; personal, round-robin, collective, and fixed round-robin engine paths |
| `POST /v2/bookings` | `2026-02-25` | Implemented | Personal and team create; attendee, guests, booking fields, metadata; `201`; optional Dapta `Idempotency-Key` extension                                                |

Success responses are `{"status":"success","data":...}`. Errors are:

```json
{
  "status": "error",
  "error": {
    "code": "RESOURCE_NOT_FOUND",
    "message": "Event type not found.",
    "details": {},
    "requestId": "req_example"
  }
}
```

API automation uses `Authorization: Bearer dcl_<prefix>_<secret>`. `/v2` does not accept `x-api-key`.
Keys require `availability:read` for slots and `bookings:write` for create. Cross-tenant and
event-type-allowlist misses return the same non-disclosing `404 RESOURCE_NOT_FOUND`.

## Selectors and identifiers

Slots and create accept exactly one of:

- `eventTypeId`;
- `eventTypeSlug` + `username`;
- `eventTypeSlug` + `teamSlug`.

`organizationSlug`, when present, is a Dapta account code or alias and must resolve to the key's
tenant. Native event-type IDs are strings. Numeric compatibility aliases are accepted and returned
where a Cal-shaped client expects a number. Booking lifecycle identity is always `uid`; numeric `id`
is a non-authoritative compatibility alias.

## Idempotency extension

`POST /v2/bookings` accepts `Idempotency-Key` (1–128 characters):

- same tenant, key, and canonical request returns the original booking without repeated side effects;
- the same key with a different request returns `409 IDEMPOTENCY_KEY_REUSED`;
- keys are hashed before being incorporated into the stored namespace.

Flow Studio must send a stable key derived before the HTTP node and reuse it across Temporal retries.
This header is a Dapta safety extension, not a Cal.com parity claim.

## Explicit R1 unsupported behavior

Known fields are never silently ignored. These variants return
`422 FEATURE_NOT_SUPPORTED` with `details.feature`:

- recurrence, seats, instant meetings, and routing;
- variable duration (a supplied duration equal to the configured duration is accepted);
- booking-time location, meeting URL, or destination-calendar override;
- reservations and `bookingUidToReschedule`;
- email verification and host-only conflict/out-of-bounds overrides;
- attendee notification locales other than `en` and `es`.

Booking-field values currently support strings, booleans, and string arrays. A personal event type
must have a public member handle because the existing personal service addresses it by handle.

## Next milestones

R2 adds booking get/list/cancel/reschedule/guests, reservations, and full mutation-idempotency
storage. R3 adds calendar discovery, busy-times, selected/destination calendars, permission
capabilities, and 100-calendar batch availability. Event-type/team discovery follows with those
surfaces. No release may claim complete Cal.com API parity.

The detailed operation and schema source of truth is [`apps/api/src/openapi.ts`](apps/api/src/openapi.ts)
and is served at `/openapi.json`.
