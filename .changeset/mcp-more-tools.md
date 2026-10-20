---
"@slate/api": minor
---

MCP: six more tools on `POST /mcp`. `hold_slot` keeps an offered slot for about
10 minutes (public page with no key, or `bookings:write` by event type id) and
returns an opaque `hold_id` bound to its caller; `book_meeting` and
`create_booking` take it as an optional `hold_id`, and the booking tools refuse a
time someone else is holding. `list_pending_bookings` (`bookings:read`) and
`confirm_booking` / `decline_booking` (`bookings:write`, decline is destructive)
answer requests that wait for the host, with the host routes' rules and side
effects and idempotent by state. `find_team_slots` and `book_team_meeting` cover
round-robin, collective and fixed round-robin teams and return the assigned
host. Like every tool that acts on the caller's account, each takes the optional
`account_id` of a sign-in that reaches several accounts (public-page calls need
none), and a sign-in's hold belongs to the person, so `book_meeting` books a hold
made while naming an account. No new scopes, env vars or tables. See
`docs/MCP.md`.
