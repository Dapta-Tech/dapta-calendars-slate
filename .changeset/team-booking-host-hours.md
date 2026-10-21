---
"@slate/db": patch
---

A team booking now goes only to a host whose own hours offer the chosen time. `createTeamBooking` already read each host's rules to check that the team offers the time; it now keeps which hosts those were, and the pick skips the rest. Before, the pick weighed bookings, holds and calendars but never the host's rules, so on a round robin event a host outside their hours, or an invited member with no schedule yet (no bookings, so the lightest load), could take a booking for a time only another host's hours offered; on fixed round robin, the rotating pick could. "Offer" means the whole meeting fits inside one of the host's own blocks, at any minute: a host whose day starts at 9:15, or who works in a zone a half hour off, still takes a time that only another host's grid lists. Collective already required every host's hours and is unchanged. No schema, API or UI change.
