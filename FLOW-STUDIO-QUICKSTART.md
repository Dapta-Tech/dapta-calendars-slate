# Flow Studio API Request quickstart

This is the copy-paste path for Nicolas's production pilot. Use generic **API Request** nodes,
Bearer auth from Vault, parsed JSON responses, fire-and-forget off, and
`https://calendar.dapta.ai` as the base URL.

## Setup

Create one `dcl_` key with `availability:read`, `event-types:read`, `calendars:read`,
`bookings:read`, and `bookings:write`. Store it as `dapta_calendars_api_key`; never put it in a URL
or log node bodies containing customer data.

Every request sends:

```text
Authorization: Bearer {{daptaVault.dapta_calendars_api_key}}
```

## 1. Discover an event type

```http
GET https://calendar.dapta.ai/v2/event-types
cal-api-version: 2024-06-14
```

Choose by `data[*].slug` plus `type`. Use `data[*].daptaId` as `eventTypeId`.

## 2. Discover calendars and optional batch availability

```http
GET https://calendar.dapta.ai/v2/calendars
```

Calendar IDs are `data.connectedCalendars[*].calendars[*].id`. Inspect `readOnly` and
`capabilities.canReadFreeBusy/canCreate`.

```http
POST https://calendar.dapta.ai/v2/calendars/availability
Content-Type: application/json

{
  "calendarIds": ["{{calendarIdA}}", "{{calendarIdB}}"],
  "from": "2026-07-24T00:00:00-05:00",
  "to": "2026-07-31T23:59:59-05:00",
  "timeZone": "America/Bogota",
  "durationMinutes": 30,
  "intervalMinutes": 30,
  "mode": "allAvailable"
}
```

Read `data.slots` for `allAvailable`/`anyAvailable`, or `data.calendars[calendarId]` for
`perCalendar`. Check `data.partial` and `data.failures` before selecting a time.

## 3. Get engine-aware slots

```http
GET https://calendar.dapta.ai/v2/slots?eventTypeId={{eventTypeId}}&start=2026-07-24T00%3A00%3A00Z&end=2026-07-31T23%3A59%3A59Z&timeZone=America%2FBogota
cal-api-version: 2024-09-04
```

Example Flow expression:

```text
{{Check_Slots.response.data["2026-07-24"][0].start}}
```

## 4. Create

```http
POST https://calendar.dapta.ai/v2/bookings
cal-api-version: 2026-02-25
Idempotency-Key: {{triggerRequestId}}:create
Content-Type: application/json

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
  "metadata": { "source": "flow-studio", "flowRunId": "{{triggerRequestId}}" },
  "bookingFieldsResponses": { "notes": "Created from an automation" }
}
```

Optionally set `destinationCalendarId` to a writable personal calendar. Save
`data.uid`, `data.title`, `data.start`, `data.end`, and `data.status`. The audited Voice Worker can
use these canonical fields without formatter changes.

## 5. Read, add a guest, reschedule, cancel

```http
GET https://calendar.dapta.ai/v2/bookings/{{bookingUid}}
cal-api-version: 2026-02-25
```

```http
POST https://calendar.dapta.ai/v2/bookings/{{bookingUid}}/guests
cal-api-version: 2024-08-13
Idempotency-Key: {{triggerRequestId}}:guests
Content-Type: application/json

{"guests":[{"email":"second@example.com","name":"Second Guest","timeZone":"America/Bogota"}]}
```

```http
POST https://calendar.dapta.ai/v2/bookings/{{bookingUid}}/reschedule
cal-api-version: 2026-02-25
Idempotency-Key: {{triggerRequestId}}:reschedule
Content-Type: application/json

{"start":"2026-07-25T16:00:00Z","rescheduledBy":"customer@example.com","reschedulingReason":"Customer requested a later time"}
```

Save the new `data.uid`. The old booking returns `rescheduledToUid`; the new one returns
`rescheduledFromUid`.

```http
POST https://calendar.dapta.ai/v2/bookings/{{newBookingUid}}/cancel
cal-api-version: 2026-02-25
Idempotency-Key: {{triggerRequestId}}:cancel
Content-Type: application/json

{"cancellationReason":"Customer cancelled"}
```

## Retry and failure policy

Generate every idempotency key before the HTTP node and reuse the unchanged request on retries.
Treat 401 as key/Vault failure, 403 as scope/calendar permission failure, 404 as unavailable or
unauthorized resource, 409 as a slot collision or changed idempotent request, 422 as an explicit
pilot gap, and 429/5xx as retryable. Escalations should record `error.requestId`, never the key.
