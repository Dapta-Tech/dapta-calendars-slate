---
"@slate/db": minor
"@slate/types": minor
---

A personal event type can have its own weekly hours ("custom hours") instead of following a schedule. A new nullable column, `schedule.event_type_id` (Postgres migration 0040, SQLite 0039, additive, bounded by `lock_timeout`), marks a schedule as private to one event type; NULL, every existing schedule, is a reusable one as before.

Custom hours are stored as an ordinary schedule with availability rules, and the event's `schedule_id` points at it, so slot generation (public pages, `/v1` and `/v2` slots, the MCP slot tools, holds, bookings and reschedules) reads them through the path it already has. They are written, replaced and removed in one transaction together with the event's pointer. A private schedule never appears in `GET /v1/schedules`, reads as not found on `GET`/`PATCH /v1/schedules/:id` (a `DELETE` is the usual idempotent 204 and leaves it alone), is never promoted to a member's default schedule, and is deleted with its event type.

`/v1` event types accept and return `customHours`:

```json
{ "customHours": { "timeZone": "America/Bogota", "ranges": [{ "days": [1, 2, 3, 4, 5], "start": "09:00", "end": "17:00" }] } }
```

`days` are weekday numbers (0 = Sunday), one row may cover several days, and rows may not overlap on a day. Omitted keeps the event's availability source; an object switches the event to those hours; `null` stops using custom hours, follows `scheduleId` (null = the host's working hours) and deletes them. A save that sends both a `customHours` object and `scheduleId`, or custom hours on a team event type, is refused with 400. A `scheduleId` must now be a reusable schedule of the same account and, for a personal event type, of its own host: another account's, another member's, or an event's custom hours is refused with 400 (before, any id was stored). A read returns `customHours` (null when none) and `scheduleId: null` while custom hours are in use. `@slate/types` adds `eventCustomHoursSchema`, `customHoursRangeSchema` and `MAX_CUSTOM_HOURS_RANGES`; `@slate/db` adds `getEventCustomHours`, `setEventCustomHours`, `clearEventCustomHours`, `isUsableSchedule`, the `…Sql` builders and `runAtomically`; an event type created or updated together with its custom hours is written in one transaction.
