---
'@slate/db': patch
'@slate/shared': patch
---

A team event's location now says it applies to every host. With an online
meeting chosen, the event editor explains that each booking's meeting link comes
from the assigned host's own connected calendar, and names the hosts who have no
destination calendar connected (their bookings would get no link). For this,
`listTeamMembers` (and so `GET /v1/teams/:id/members`) returns a new boolean,
`has_destination_calendar`, account-scoped and computed the same way on SQLite
and Postgres; every existing field is unchanged. New copy in EN and ES. Booking
and calendar behavior are unchanged.
