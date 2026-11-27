---
'@slate/api': patch
---

A reschedule whose event the host deleted on their calendar writes the event again at the new time and keeps the new id; the organizer's dead conferencing room is replaced on every row and co-host copy (or cleared). Reminders and follow-ups are skipped when every event written for the booking was deleted on its calendar, and still go out while a calendar write is queued, after a reschedule wrote it again, or whenever the lookup cannot tell. Series updates, occurrence moves and guest re-invites against a deleted event are recorded as skipped, never as done. The generic REST contract gains `GET /v1/connections/:ref/events/:id`, called only with `CALENDAR_BACKEND_FEATURES=event-lookup`, and reads `cancelled`/`status` on a move.
