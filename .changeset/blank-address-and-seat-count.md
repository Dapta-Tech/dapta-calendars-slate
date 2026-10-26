---
"@slate/db": patch
---

Every path that adds someone to a booking refuses an address that normalizes
to nothing (empty or blank) with `INVALID`: `addAttendeeToBooking`,
`addGuestsToBooking`, `createBooking` (a seat on a group slot included) and
`createTeamBooking` ("Every attendee needs an email address."). Such an
address was nobody to the people count, so repeated adds could write rows
past every cap.

A group slot's seats now count everyone on it the way `peopleOn` does:
attendee rows, guest rows added through v2 and the guests the booking names
in its metadata, each address once. The availability read, the hold check
and the seat write all count that way, so guests can no longer leave a slot
looking free past its seats. A guest asking for a seat is already on the
slot, and gets the replay. `peopleRowsSql` and `peopleOn` move to the
repository module, shared by every count and dedupe of a booking's people.
The specs share one member-with-hours fixture (`member-hours.fixture.ts`,
left out of the build like the specs).
