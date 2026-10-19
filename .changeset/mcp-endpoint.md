---
"@slate/api": minor
---

Add a remote MCP endpoint, `POST /mcp` (Streamable HTTP, stateless, official
TypeScript SDK v2; serves 2026-07-28 and legacy `initialize` clients from one
handler). Ten tools: `find_available_slots`, `book_meeting` (public pages, no
key), `whoami`, `list_event_types`, `get_booking_page_link`, `list_bookings`,
`get_booking`, `create_booking`, `reschedule_booking`, `cancel_booking`
(`dcl_` API key, scope-checked, account taken from the key). Per-key and
per-address rate limits with a tighter write bucket, Origin and optional Host
validation, a per-call timeout, and one redacted audit line per tool call.
Invitee text is returned only inside a labelled, length-capped `invitee_supplied`
object. The REST cancel routes (`/v2` and `/v1/machine`) now also accept the new
`bookings:cancel` scope. New optional env: `MCP_ENABLED`, `MCP_PUBLIC_URL`,
`MCP_ALLOWED_ORIGINS`, `MCP_ALLOWED_HOSTS`, `MCP_RATE_LIMIT_*`,
`MCP_WRITE_RATE_LIMIT_*`, `MCP_TOOL_TIMEOUT_MS`. See `docs/MCP.md`.
