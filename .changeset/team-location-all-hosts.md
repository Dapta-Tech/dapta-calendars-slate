---
'@slate/db': minor
'@slate/shared': minor
---

A team event's location now says it applies to every host. With an online
meeting chosen, the event editor explains where each booking's meeting link
comes from: the calendar where the assigned host receives new events (round
robin), or where one of the booking's hosts does (collective, fixed round
robin). It warns when bookings would get no link, by scheduling method: round
robin names each host without such a calendar; collective warns only when no
host has one; fixed round robin is silent when a fixed host has one, and
otherwise names the rotating hosts without one. Names are sorted and joined for
the page's language. For this, `listTeamMembers` (and so
`GET /v1/teams/:id/members`) returns a new boolean, `has_destination_calendar`,
account-scoped and computed the same way on SQLite and Postgres; every existing
field is unchanged. New copy in EN and ES. Booking and calendar behavior are
unchanged.
