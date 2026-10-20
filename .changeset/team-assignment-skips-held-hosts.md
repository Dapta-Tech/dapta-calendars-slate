---
"@slate/db": minor
---

Team bookings no longer assign a host who is holding that time on one of their
own events (a booking page's soft hold, or the MCP `hold_slot` tool), the same
way the team slot list already leaves them out, and exactly as they treat a
host with a booking. Round-robin picks another free host; a held collective or
fixed host makes the time `SLOT_TAKEN` instead of being assigned around. The
check runs again inside the guarded insert, under the member lock the hold
write takes, so a hold that lands while hosts are being picked is respected.
`createBooking` and `rescheduleBookingV2` take an opt-in `refuseHeld` that does
the same for a personal booking or a move (the hold a booking consumes is its
own); off by default, so REST personal bookings are unchanged.
