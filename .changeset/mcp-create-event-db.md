---
"@slate/db": minor
"@slate/shared": minor
---

`@slate/db`: `createHostEvent` writes a host's own event as a booking with no
event type (`event_type_id` NULL): any time and length, its own title and body,
attendees once each without the host, `seated = 1` so a guest added later keeps
the title. It reads the host's dCal bookings, other callers' holds and the
connected calendar's busy time (fail closed), refuses an overlap with a dCal
booking always and the rest unless `allowConflicts`, and writes under the host's
lock with the same overlap check as every booking. A repeated idempotency key
replays the event, also when a retry races its first attempt (the key is read
again under the lock and before any refusal); the same key with other
arguments is refused (`replayHostEvent`). `isHostEvent` and `isHostEventRow`
tell such a booking apart. `rescheduleBookingV2` and the v1 `rescheduleBooking`
move a host event to any time (no event type, so no hours), and once its copy
is on the calendar do not read its old time there as busy (`hostEventOwnTime`,
`busyOutside`); `rescheduleBookingV2` now carries `location_kind` to the moved
booking. `loadBusyForHost` counts a host event as
busy when it leaves a group event's own bookings out. `hostOverlapSql` is
exported for the guarded writes.

`@slate/shared`: the server analytics event `host_event_created`, and the copy
for `create_event` on the Tools page and the API docs page (English and
Spanish).
