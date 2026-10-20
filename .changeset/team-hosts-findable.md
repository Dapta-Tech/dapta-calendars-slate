---
"@slate/db": patch
"@slate/shared": patch
---

A team's roster and its events' hosts now move together. `addTeamMember` makes
the member a host of every event the team already has, with the values the
editor saves (priority 0, weight 100, not fixed, no own schedule), skipping
events that already have them, so repeating it adds nothing and never resets a
host's own priority or weight. `removeTeamMember` clears the member's host rows
on that team's events only. Before, a new member showed in the editor's host
list but took no bookings until someone saved the event again, and a removed
member kept receiving bookings, because booking reads the host rows and not the
roster. Both run on the idempotent paths too (already a member, already gone),
so a repeat call repairs a half-finished add or a row a removal left behind.
Account-scoped, no schema change and no migration.

The event editor now says where hosts come from. A personal event shows a
Hosts card in the slot where a team event shows its Hosts block: the event is
only yours, with a "New event for {team}" link per team (or "Create a team"
when there is none). A team event's Hosts block says every member of the team
hosts it and links to the team page, where members are added and removed. The
Events list shows every team, with or without events, each with its own
"New event for {team}" link. New copy in EN and ES under
`admin.eventTypes.teamHosts`.
