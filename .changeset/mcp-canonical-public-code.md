---
"@slate/api": patch
---

The MCP's `list_event_types` and `get_booking_page_link` build booking links
with the account's canonical public code, the claimed vanity slug when there is
one, instead of the short code. An agent was handed a link the web layer
redirects and that disagreed with the link the admin shows the host.
