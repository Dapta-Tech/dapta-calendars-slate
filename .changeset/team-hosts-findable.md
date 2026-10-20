---
"@slate/db": patch
"@slate/shared": patch
---

A team's roster and its events' hosts now move together. `addTeamMember` makes
the member a host of every event the team already has, with the values the
editor saves (priority 0, weight 100, not fixed, no own schedule), skipping
events that already have them, so repeating it adds nothing and never resets a
host's own priority or weight. A collective event takes the member only once
they have a schedule: everyone attends those, and an invited member has no
hours until their first sign-in, so adding them would empty the event for the
whole team. `removeTeamMember` clears the member's host rows on that team's
events only, whatever wrote them. Before, a new member showed in the editor's
host list but took no bookings until someone saved the event again, and a
removed member kept receiving bookings, because booking reads the host rows and
not the roster. Both run on the idempotent paths too (already a member, already
gone), so a repeat call repairs a half-finished add or a row a removal left
behind.

Host inserts no longer fail on the unique (event_type_id, member_id) index: the
add skips a row written in the meantime, and `setEventTypeHostsDetailed`
overwrites one with the values it was given instead of failing the save and
dropping every host after it. Account-scoped, no schema change and no
migration.

The event editor now says where hosts come from. A personal event shows a
Hosts card in the slot where a team event shows its Hosts block: a personal
event has one host, with a "New event for {team}" link per team (or "Create a
team" when there is none). A team event's Hosts block says every member of the
team hosts it and links to the team page, where members are added and removed.
The Events list shows every team, with or without events, each with its own
"New event for {team}" link. The links are for owners and admins, who are the
only ones the API lets create teams and team events; a plain member reads the
explanation without them. New copy in EN and ES under
`admin.eventTypes.teamHosts`.
