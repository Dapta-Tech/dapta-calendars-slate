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

**Location kind**:
WHERE a meeting happens, as one of four vendor-neutral values — `conferencing`, `in_person`, `phone`, `custom` — plus an optional detail. Configured on the event type and snapshotted onto each booking, so editing the event type later never rewrites what a past booking meant. `conferencing` is the only kind with no host-typed detail: the link is minted by the calendar port.
_Avoid_: location (ambiguous — that word is the human string), meeting type, any vendor name

**Calendar write-out**:
Pushing a confirmed booking onto the host's connected external calendar through the vendor-neutral calendar port, with a conferencing link attached.
_Avoid_: sync (that's free-busy reading), any vendor name

**Transactional email**:
An email the system sends because a booking changed state — confirmation, pending, declined, cancellation, reschedule. Its text is account-wide; hosts never write it per event.
_Avoid_: notification (covers reminders too), lifecycle email

**Reminder**:
A scheduled email sent a chosen time before a booking starts. Owned by the event type, not the account: each one has its own switch, lead time, subject, and body.
_Avoid_: notification, alert

**Follow-up**:
A reminder's mirror after the meeting ends. Same shape, same ownership, disabled unless the host turns it on.
_Avoid_: post-event email, thank-you email

**Form variable**:
A placeholder in reminder copy that prints an answer to one of that event's own intake questions, written `{{form.<field name>}}`. The prefix keeps a question named `location` from shadowing the built-in `{{location}}`.
_Avoid_: custom variable, merge tag
