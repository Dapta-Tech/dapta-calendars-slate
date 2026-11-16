---
"@slate/api": patch
---

A booking on a video meeting now says where it happens and carries its join
link as soon as it exists, through the MCP and `/v2`. An agent used to read
`location: null` and `meeting_url: null` and conclude the link was missing,
while the confirmation email had it.

- Every MCP booking answer (`create_booking`, `get_booking`, `confirm_booking`,
  `reschedule_booking`, `cancel_booking`, `create_event`) adds `location_kind`
  and `meeting_url_status` (`ready`, `pending`, `on_confirmation`, `none`), and
  `location` reads as the kind of meeting ("Online meeting") when the place has
  no text of its own.
- `create_booking`, `confirm_booking` and `reschedule_booking` wait a few
  seconds for the link the calendar creates, as `create_event` does, and answer
  `pending` when it is still not there; a request that waits for the host says
  the link is created when the host confirms.
- `book_meeting` and `book_team_meeting`, signed in or not, add the same four
  fields to their booking and wait the same way; a retry with the same
  `idempotency_key` reads the link as it is by then.
- `list_bookings` and `list_pending_bookings` rows carry `location_kind`,
  `meeting_url` and `meeting_url_status` (never the place's own text).
- `GET /v2/bookings/:uid` adds `locationKind` and `meetingUrlStatus`.
