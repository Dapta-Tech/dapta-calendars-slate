---
"@slate/shared": patch
---

Three more read tools on the MCP: `list_calendar_connections` (the connected
calendar accounts, their role and last health check, needs `availability:read`),
`get_brand_kit` and `get_booking_page_settings` (the brand kit, the link name and
whether the branding shows, need `event-types:read`). They close four more
`not-yet` routes in `parity.ts`.
