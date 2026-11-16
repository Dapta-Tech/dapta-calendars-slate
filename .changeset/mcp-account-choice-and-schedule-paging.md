---
"@slate/api": patch
---

An MCP sign-in's memberships are verified against the member rows before any
account choice is built from them: a member who is missing or no longer active
is dropped, so a disabled or removed member no longer learns workspace names or
ids from the `ACCOUNT_REQUIRED` answer, and a sign-in left with no active
member is refused with `FORBIDDEN`. `list_schedules` pages through every
schedule with `cursor` and `next_cursor` instead of silently dropping those
after the first 200, and the capped lists (`list_event_types`,
`list_one_off_links`, `list_teams`, `list_team_members`, `list_members`,
`list_connection_calendars`, `list_calendar_connections`) now say `truncated`
when more exist than were returned.
