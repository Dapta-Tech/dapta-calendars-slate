# Dapta Calendars

Open-source, self-hostable scheduling: hosts publish availability, invitees book it. The product is a free lead magnet for the Dapta platform — it never bills anyone.

## Language

**Host**:
A member who owns availability and takes bookings, alone or as part of a team.
_Avoid_: user (ambiguous), organizer

**Invitee**:
The person booking a slot on a public booking page. Unlimited and always free.
_Avoid_: attendee (the DB word; fine in code, not in product copy), guest, lead

**Useful parity**:
The subset of Calendly a typical host actually uses: public bookings, availability, teams, configurable email reminders, embeds, conferencing links + calendar write-out, abuse limits. The pilot's feature bar — deliberately NOT full Calendly parity.
_Avoid_: full parity, feature-complete

**Pilot**:
The first launchable release: production quality, Forms-level UI/UX, dogfooded internally first, but switch-on-able for end users at any moment.
_Avoid_: MVP, beta, demo

**Embed**:
The widget (inline or popup) that puts a booking page inside a third-party site via a script tag.
_Avoid_: iframe (an implementation detail), widget (alone)

**One-off link**:
A single-use booking link that dies after one booking. An abuse limit, not a new event type.
_Avoid_: single-use event

**Reskin**:
Bringing Calendars' public page and admin to the Dapta Forms design language (tokens, components, polish). Visual/UX work on existing screens, not new features.
_Avoid_: redesign (implies rethinking flows)

**Calendar write-out**:
Pushing a confirmed booking onto the host's connected external calendar through the vendor-neutral calendar port, with a conferencing link attached.
_Avoid_: sync (that's free-busy reading), any vendor name
