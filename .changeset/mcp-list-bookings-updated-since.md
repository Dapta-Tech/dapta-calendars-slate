---
"@slate/api": patch
---

MCP `list_bookings` (and `list_pending_bookings`) take `updated_since`: only
bookings created or changed (confirmed, declined, moved or cancelled) at or
after that instant. With it and neither `from` nor `to`, bookings at any start
time are listed, so a booking cancelled after its time still shows as a
change. An agent that only has the MCP can now ask "what changed since my last
check" instead of re-reading the whole list. Each page returns
`next_updated_since`, the server's time a minute before the read, to pass back
next time (a few bookings may repeat; none are missed while a write commits),
and each row carries `rescheduled_from_uid` / `rescheduled_to_uid`, so a move
made as cancel plus new booking reads as one move. The tool description says so and
names webhooks (API and webhooks, then Webhooks) for being told without
polling. `docs/MCP.md` lists the argument.
