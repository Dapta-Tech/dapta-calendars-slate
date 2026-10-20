---
"@slate/db": patch
---

Team bookings no longer assign a host who is holding that time on one of their
own events (a booking page's soft hold, or the MCP `hold_slot` tool), the same
way the team slot list already leaves them out. Round-robin picks another free
host; a held collective or fixed host makes the time `SLOT_TAKEN` instead of
being assigned around. Before, the held host could be assigned and the holder's
own booking then failed.
