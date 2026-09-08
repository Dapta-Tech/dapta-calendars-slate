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
A booking page placed inside a third-party site, inline in that page's flow. A popup variant is possible later but is not what the word means today.
_Avoid_: iframe (an implementation detail), widget (alone)

**Embed mode**:
The stripped rendering a public booking page uses when embedded: no back-to-profile link, tighter padding, and it reports its own height to the page around it. Same page and same data as the normal one.
_Avoid_: embed view, headless

**Theme override**:
An accent colour or style axis passed in the embed's URL so the booking page matches the site hosting it, instead of the host's own booking-page style. Only ever read in embed mode.
_Avoid_: custom CSS, branding (that's the host's own saved style)

**One-off link**:
A single-use booking link a host mints for one intended invitee, over an event type they already have. It dies the moment a booking is made against it, and cancelling that booking does not revive it. It only means anything on a hidden event type — while the event is public, anyone can book it without the link.
_Avoid_: single-use event, one-off meeting (Calendly's ad-hoc meeting is a different thing we have not built)

**Duplicate-booking guard**:
A per-event-type switch that stops one email address holding more than one upcoming booking on that event. It counts a normalized email that nobody verifies, so it prevents accidents rather than defeating anyone. Off unless the host turns it on.
_Avoid_: rate limit (that is the per-IP throttle), abuse limit (implies it stops an attacker)

**Reskin**:
Bringing Calendars' public page and admin to the Dapta Forms design language (tokens, components, polish), and with it real light-mode support. Visual work on existing screens, not new features — the one capability it adds is the ability to be looked at in either theme.
_Avoid_: redesign (implies rethinking flows)

**Location kind**:
WHERE a meeting happens, as one of four vendor-neutral values — `conferencing`, `in_person`, `phone`, `custom` — plus an optional detail. Configured on the event type and snapshotted onto each booking, so editing the event type later never rewrites what a past booking meant. `conferencing` is the only kind with no host-typed detail: the link is minted by the calendar port.
_Avoid_: location (ambiguous — that word is the human string), meeting type, any vendor name

**Calendar write-out**:
Pushing a confirmed booking onto the host's connected external calendar through the vendor-neutral calendar port, with a conferencing link attached.
_Avoid_: sync (that's free-busy reading), any vendor name

**Location kind**:
How an invitee and host actually meet, chosen once per event type: an automatic meeting link, an address, a phone call the host places, or free text the host writes. It is a choice from a closed set, not a sentence — the free-text case is one of the four, not the default.
_Avoid_: location (alone; that's the human-readable line an invitee reads), meeting type, venue

**Meeting link**:
The join URL minted by the host's connected calendar when the event type asks for one. One per booking, never per host, and it survives a reschedule unless the platform itself reissues it. Absent whenever no calendar is connected — the booking stands regardless.
_Avoid_: conferencing link (fine in the roadmap, but the product word is meeting link), any vendor's name for its own room

**Integration**:
A pasted, account-level credential to an external CRM, connected once by an owner or admin and shared by every host in the workspace. One per provider.
_Avoid_: connection (that word belongs to calendars), connector, OAuth app

**CRM write-out**:
Pushing a confirmed booking to the connected CRM as a contact plus a meeting activity on that contact. Mirrors calendar write-out: one-directional, and a CRM failure never blocks or undoes the booking.
_Avoid_: sync (implies two-way, or free-busy reading), CRM push

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

**Qualification**:
The commercial question bank a new workspace answers once — who they are, what they sell, how many leads they move. It describes the account and its company, never an individual host, and it is what turns a signup into a lead.
_Avoid_: onboarding (that covers setup too), survey, wizard

**Setup**:
The half of onboarding that makes one host bookable: pick a template, get a first event type. It belongs to the member, so every host does it, including someone invited into a workspace that is already qualified.
_Avoid_: onboarding (ambiguous), configuration

**Template**:
A named starting point for a host's first event type — title, duration, slug, description, intake questions. It lives in a server-side registry; a host names one by id and never supplies its config.
_Avoid_: preset, blueprint, default event type

**Growth CRM**:
Dapta's own CRM, where a signup becomes a lead. Distinct from the CRM a host connects to their workspace, which receives their bookings. When either could be meant, say "growth CRM" or "the host's CRM" — never a bare vendor name.
_Avoid_: HubSpot (names a vendor without saying whose portal), the CRM

**Entry type**:
How a person first reached Calendars: `self_serve` if they signed up themselves, `workspace_invite` if a host brought them in. It rides alongside lead source rather than replacing it, so an invitation never overwrites how a person was originally acquired.
_Avoid_: lead source (that is campaign attribution), signup type

**Design language**:
The Dapta Forms visual system Calendars converges on: a dark-first console palette lit by exactly two saturated colours, a pinned type and radius scale, and tonal depth instead of shadows. It governs the chrome the product paints, never the colour a host picks for their own page.
_Avoid_: design system (that is the code — tokens and components), theme, branding

**Product theme**:
Light or dark, chosen by a host for the surfaces they work in. It is a per-device preference, not a property of the account, and it stops at the admin — it never reaches anything an invitee sees.
_Avoid_: theme (ambiguous once the booking page has one of its own), dark mode

**Booking page theme**:
Light or dark for the public page, chosen by the host as one of its style axes and seen in the studio preview before it ships. Independent of that host's own product theme, and never derived from the invitee's device. Light unless the host says otherwise.
_Avoid_: theme, product theme, appearance

**Accent**:
The single colour a host picks for their booking page. Everything else on that page is derived from it, including the shade it takes as text and as an edge, which are recomputed against whichever ground the page is rendering on.
_Avoid_: primary (the token name, not the product word), brand colour, theme colour

**Property mapping**:
A host's instruction that one thing a booking knows — an intake answer, an attendee detail, or a fact about the event itself — should land in a named field on the CRM contact. It belongs to the event type whose questions it maps, and it never invents a field that does not already exist in the host's CRM.
_Avoid_: field mapping (a booking field is only one of the sources), sync, integration mapping

**Mapping source**:
Anything a property mapping can read from: one of the event type's intake questions, one of the attendee's own details, or one of a fixed handful of facts about the booking. The invitee's email and name are not sources — they are identity, and they are always sent.
_Avoid_: field, input, variable (that word belongs to reminder copy)

**Promotion**:
Moving the whole of `develop` onto `main` so it can be released. It always carries everything waiting, never a hand-picked subset, and it is the only way code reaches `main`. Frequent and unremarkable by design — a promotion that feels like an event means too much has queued up behind it.
_Avoid_: release (that is what happens to a promoted tree afterwards), merge to main, deploy

**Release loop**:
The fixed order every change travels: an agent opens the pull request, Josue merges it, the dev environment picks it up, Josue tests it there, and only then is it promoted. An agent never merges its own work, and no step is ever skipped for urgency — urgency changes how fast the loop turns, not its shape.
_Avoid_: workflow, branch flow, CI/CD

**QA pass**:
The agent driving the running app in a browser and confirming its own feature actually works before opening the pull request, with the evidence attached to that request. It proves this change behaves; it is not a suite anybody keeps.
_Avoid_: test (that is a committed, repeatable thing), smoke test, E2E

**Pilot environment**:
One of the two deployed copies of Calendars: the dev one, where Josue tests what was just merged, and the production one, which is what end users would reach if the pilot were switched on. They differ in which step of the release loop they serve, not in quality.
_Avoid_: staging (implies a rehearsal of production rather than a step in the loop), instance

**Go-live**:
Switching the pilot on for end users. A separate act from releasing: code can be in production for days before anyone is invited to use it, and it stays that way until the things an invitee depends on — most of all, the email they get — are verified.
_Avoid_: launch (that is the public marketing effort, a different project), release, ship
