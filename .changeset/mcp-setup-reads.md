---
"@slate/api": minor
"@slate/web": patch
"@slate/shared": patch
---

Four read tools on the MCP: `list_schedules` and `get_schedule` (the working
hours the Availability page shows, needs `availability:read`), and
`get_event_type` and `list_one_off_links` (one event type's editor settings and
its single-use links, needs `event-types:read`, respects the allowlist). They
close four `not-yet` routes of the dashboard API in `parity.ts`. The connect and
Tools pages list them.
