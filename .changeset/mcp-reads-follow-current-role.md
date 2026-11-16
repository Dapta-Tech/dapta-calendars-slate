---
"@slate/api": patch
---

`list_schedules`, `get_schedule`, `list_event_types` and `get_event_type` now follow the signed-in
member's current role, read from the member row on each call rather than taken
from the access token. An admin still reads every schedule and event type; a
member demoted after connecting reads only their own, as the dashboard does
(`list_schedules` and `list_event_types` (bookable ones, hidden left out) list just theirs, `get_schedule` and `get_event_type` refuse another member's with
`FORBIDDEN`). API keys, which act for the account, are unchanged.
