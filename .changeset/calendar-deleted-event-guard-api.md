---
'@slate/api': patch
---

A reschedule whose event the host deleted on their calendar writes the event again at the new time and keeps the new id. Reminders are skipped when every event written for the booking was deleted on its calendar, and still go out after a reschedule wrote it again, or whenever the lookup cannot tell. The generic REST contract gains `GET /v1/connections/:ref/events/:id` and reads `cancelled`/`status` on a move.
