---
"@slate/api": minor
---

MCP: six more tools on `POST /mcp`. `hold_slot` keeps an offered slot for about
10 minutes (public page with no key, or `bookings:write` by event type id) and
returns an opaque `hold_id`, bound to the key, connection or person that made
it (an anonymous hold's id is itself the capability); `book_meeting` and
`create_booking` take it as an optional `hold_id`, and the MCP booking and
reschedule tools refuse a time someone else is holding, inside the booking's
locked write (one-host bookings made straight through the REST API are not
checked against holds yet). `list_pending_bookings` (`bookings:read`) and
`confirm_booking` / `decline_booking` (`bookings:write`, decline is destructive)
answer requests that wait for the host, with the host routes' rules and side
effects and idempotent by state. `find_team_slots` and `book_team_meeting` cover
round-robin, collective and fixed round-robin teams and return the assigned
host. Like every tool that acts on the caller's account, each takes the optional
`account_id` of a sign-in that reaches several accounts (public-page calls need
none), and a sign-in's hold belongs to the person, so `book_meeting` books a hold
made while naming an account. No new scopes, env vars or tables. See
`docs/MCP.md`.
