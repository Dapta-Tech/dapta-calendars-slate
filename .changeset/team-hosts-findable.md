---
"@slate/shared": patch
---

The event editor now says where hosts come from. A personal event shows a Hosts card in the slot where a team event shows its Hosts block: a personal event has one host, with a "New event for {team}" link per team (or "Create a team" when there is none). A team event's Hosts block says every member of the team hosts it once the event is saved, and links to the team page, where members are added and removed. The Events list shows every team, with or without events, each with its own "New event for {team}" link. The links are for owners and admins, who are the only ones the API lets create teams and team events; a plain member reads the explanation without them. New copy in EN and ES under `admin.eventTypes.teamHosts`.
