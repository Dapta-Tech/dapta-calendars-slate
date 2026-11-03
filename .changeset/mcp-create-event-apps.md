---
"@slate/api": minor
"@slate/web": patch
---

MCP: `create_event`, the eighteenth tool. A host's agent puts an event of the
host's own on the host's calendar: any title, any start and length (5 minutes
to 24 hours, not limited to offered slots), 0 to 10 attendees by email, an
optional body and an optional video link from the connected calendar. Scope
`bookings:write`; a sign-in acts for its own member, an API key for the
workspace owner `whoami` names, and a key held to some event types is refused.
The host's busy times are read first (fresh, ADR 0009): busy time on the
connected calendar or another caller's hold answers `CONFLICT` listing what is
there and writes nothing, unless `allow_conflicts` is true; another dCal
booking of the host is never overlapped (`SLOT_TAKEN`), under the same lock and
`booking_no_overlap` EXCLUDE as every booking. Attendees or a video link with no
calendar to write to answer `NO_CALENDAR`. The calendar write goes through the
outbox, and the connected calendar invites the attendees. Product analytics
records `calendars_host_event_created`.

The event is a booking with no event type, so it reads, moves and cancels like
one: `list_bookings` and its `updated_since` feed list it (`kind: event`, its own
`title`, an empty `event_type_id` so sessions listed before stay valid),
`get_booking` reads it with its attendees, `reschedule_booking` moves it to any
time with its length, and `cancel_booking` removes it from the calendar, which
tells its attendees. dCal sends no email about it, no booking webhook and no CRM
write-out, on any path (MCP, v1, v2, the dashboard). A key held to some event
types does not see it. Booking results gain `kind` and `title`.

Fixed on the way, for every booking: the v2 reschedule keeps the booking's
location kind (a moved booking asked for a video link it had not asked for, or
stopped asking), and a group event's availability counts a host event as busy.
The web Tools page and the key scopes list the new tool, in English and Spanish.
