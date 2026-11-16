---
"@slate/types": minor
"@slate/config": minor
"@slate/shared": patch
---

Agents can create event types and change their safe fields over MCP. A new
API-key and OAuth scope, `event-types:write`, gates two new tools,
`update_event_type` (title, description, length, location, intake questions,
hidden, minimum notice, confirmation, booking window) and `create_event_type`
(the same, created hidden unless `hidden: false`, with an optional link name
`slug`, otherwise taken from the title; a taken one is `CONFLICT`). Both are off unless the server
env sets `MCP_EVENT_TYPE_WRITE_ENABLED=true`; off, neither is listed nor
callable. Everything else on an event type (the redirect after booking,
tracking, reminders, CRM mappings, hosts, team, the link name of an existing
event type) stays in the dashboard. Text carries no links or web addresses (`URL_NOT_ALLOWED`) and no
invisible characters; replacing the questions needs the `revision` that `get_event_type`
and `list_event_types` now return (`if_revision`, `CONFLICT` when stale). The
web app shows the scope as "Edit event types" / "Editar tipos de evento" and
lists both tools. ADR 0013 records the design.
