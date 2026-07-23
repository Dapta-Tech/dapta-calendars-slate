# Flow Studio API Request quickstart

R1 lets a generic Flow Studio API Request node check slots and create personal or team bookings.
Calendar discovery and the complete booking lifecycle arrive in later milestones; see
[`CAL-COMPATIBILITY.md`](CAL-COMPATIBILITY.md).

## One-time setup

1. Create a Dapta Calendars API key with `availability:read` and `bookings:write`.
2. Store it in Vault as `dapta_calendars_api_key`.
3. Use the generic **API Request** node, not a provider-specific calendar node.
4. Choose Bearer auth with `{{daptaVault.dapta_calendars_api_key}}`.
5. Leave fire-and-forget off.

The examples use `https://calendars-api.dapta.ai`. Replace the event-type ID and timestamps.

## Check slots

| Node field | Value                                     |
| ---------- | ----------------------------------------- |
| Method     | `GET`                                     |
| URL        | `https://calendars-api.dapta.ai/v2/slots` |
| Header     | `cal-api-version: 2024-09-04`             |
| Query      | `eventTypeId={{eventTypeId}}`             |
| Query      | `start=2026-07-24T00:00:00Z`              |
| Query      | `end=2026-07-31T23:59:59Z`                |
| Query      | `timeZone=America/Bogota`                 |

The parsed body is stored under `response`. A slot start is available at:

```text
{{Check_Slots.response.data["2026-07-24"][0].start}}
```

## Create a booking

Derive the idempotency key from a stable trigger or business-request ID before this node. Do not
generate a new key inside a retry.

| Node field | Value                                                  |
| ---------- | ------------------------------------------------------ |
| Method     | `POST`                                                 |
| URL        | `https://calendars-api.dapta.ai/v2/bookings`           |
| Header     | `Content-Type: application/json`                       |
| Header     | `cal-api-version: 2026-02-25`                          |
| Header     | `Idempotency-Key: {{triggerRequestId}}:create-booking` |
| Raw body   | JSON below                                             |

```json
{
  "eventTypeId": "{{eventTypeId}}",
  "start": "{{Check_Slots.response.data[\"2026-07-24\"][0].start}}",
  "attendee": {
    "name": "Test Customer",
    "email": "customer@example.com",
    "timeZone": "America/Bogota",
    "language": "es"
  },
  "guests": ["guest@example.com"],
  "metadata": { "source": "flow-studio" },
  "bookingFieldsResponses": { "notes": "Created from an automation" }
}
```

Read the lifecycle identifier at `{{Create_Booking.response.data.uid}}`. Canonical times are
`data.start` and `data.end`; there are no `startTime` or `endTime` REST aliases.

## Retry and error handling

- Repeat the create node with the same idempotency key and unchanged body: the same `uid` is returned.
- Reusing the key with a different body returns `409 IDEMPOTENCY_KEY_REUSED`.
- Treat 401 as a key/Vault problem, 403 as a missing scope, 404 as absent/cross-tenant/out-of-allowlist,
  409 as a collision or idempotency mismatch, 422 as a documented unsupported feature, and 429/5xx
  as retryable according to the flow policy.
- Record `error.requestId` when escalating a failed call; never log the key or attendee body.
