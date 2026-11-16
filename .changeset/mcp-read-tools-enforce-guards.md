---
"@slate/api": patch
---

The MCP read tools enforce the same authorization as the dashboard route each
one mirrors. `list_members`, `list_notification_settings` and
`list_integrations` (which also returns the deployment's CRM capabilities) are
for a signed-in owner or admin, checked against the member's current role on
every call; an API key has no member role and is refused instead of acting as
the workspace owner. `list_one_off_links` carries live single-use booking
tokens, so it needs a sign-in as the event type's owner or an admin, and an API
key never receives a token. `list_calendar_connections` and
`list_connection_calendars` show only the caller's own connections, as the
Calendars screen does: a key reads the workspace owner's, and needs
`bookings:write` with no event-type limit, the bar `check_availability` already
sets. The tool descriptions and `docs/MCP.md` say so.
