---
"@slate/db": patch
---

`listAccountSchedules` reads every member's reusable schedules in an account,
with the owner's name, beside `listSchedules`, so the MCP `list_schedules`
shares the reusable-schedule filter and default marker instead of repeating the
query.
