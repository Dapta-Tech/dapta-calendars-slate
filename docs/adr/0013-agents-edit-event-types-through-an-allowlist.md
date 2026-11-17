# Agents edit event types through an allowlist

Until now the MCP read event types and never changed them. Writes were left out on purpose: an event type carries the fields that send booking data somewhere else (the redirect after booking and what it carries, tracking scripts on the public page, CRM property mappings, reminder and calendar templates that are emailed or written to calendars) and the fields that decide who hosts it. An agent that a stranger's text can steer (prompt injection) must not reach those. Hosts still asked their agents for the plain edits: add a required question, fix a title, move a meeting to a phone call, publish a new event.

Two tools now do that, `update_event_type` and `create_event_type`, under a new scope, `event-types:write`, and behind a switch, `MCP_EVENT_TYPE_WRITE_ENABLED`, which is off unless a deployment turns it on.

## An allowlist, not a denylist

The tools accept nine fields and nothing else: title, description, length, location (kind and detail), the intake questions, hidden, the minimum notice, whether bookings wait for the host's confirmation, and the booking window (how many days ahead, or no limit). The last two are a flag and a number the dashboard already validates, with no text or address in them. `create_event_type` also takes the link name (`slug`). Their input schemas are strict, so any other field is refused with an error naming it, never quietly dropped. A field added to event types later stays out of the MCP until someone adds it here on purpose.

Kept out, and why:

- **The redirect after booking and what it carries, tracking, CRM mappings, reminders, calendar title and description templates.** Each sends booking data, or text an agent wrote, somewhere other than the booking page.
- **Hosts, team, scheduling method, distribution, schedule, custom hours, calendars, seats.** Who hosts and when is team and availability administration.
- **The link name (slug) on an update.** Changing it breaks every link already shared. A new event type takes the one the call gives (lowercase letters and digits joined by `-`; one the host already uses is `CONFLICT`, never silently changed) or gets one from its title, with a number added when it is taken.
- **The `guests` question type.** It adds addresses the invitee chooses to the invitation.
- **Deleting an event type.** It takes a public page down and cannot be undone.

## What an agent may write

The text an agent writes lands on a public booking page, in emails and on calendars, so the server checks it before anything is written (`apps/api/src/mcp/event-type-guard.ts`, pure and unit-tested):

- **No links or web addresses, in any text field.** A prompt-injected agent could otherwise put a phishing link on a page the host's invitees trust, and mail and calendar apps turn a bare `name.com` into a link by themselves. The text is NFKC-normalized first (fullwidth letters read as plain ones) and refused with `URL_NOT_ALLOWED`, naming the field, when it has, anywhere and whatever comes before it: `://` or `:\\`; a host after `//` or `\\`; `www.`; one of `http:`, `https:`, `javascript:`, `data:`, `vbscript:`, `file:` or `mailto:` directly followed by something; a `name.tld` whose top-level part is a common one (`com`, `io`, `co`, `ai`, country codes and the like) or punycode (`xn--`); any `name.tld/` followed by a path; a dotted IPv4 address. Words like `Next.js`, `e.g.`, `v1.2` or `3.5 hours` pass. A bare email address is refused too, through its domain. A person can still add a link in the dashboard.
- **No invisible text.** Control, format (bidi, zero-width, tags) and private-use characters, line and paragraph separators, the blanks that show nothing (U+034F, U+115F, U+1160, U+3164, U+FFA0, U+2800) and variation selectors other than the two emoji-style ones are refused: they are how an instruction hides inside a label. A joiner between two emoji stays, and line breaks and tabs are allowed in the description only. A phone detail is checked like any text before it is read as a number.
- **Locations that mean what they say.** `conferencing` takes no detail (the calendar makes the link), `phone` takes a phone number, `in_person` and `custom` take plain text under the rules above.
- **Questions the booking page can render.** At most 30, each with a unique name of lowercase letters, digits and `_` (a name the event type already uses may keep its shape), none of the names the page asks by itself, and 1 to 50 options of at most 200 characters for `select` and `checkbox`.

Then the save goes through the same checks a dashboard save meets (`apps/api/src/event-type-write.ts`, shared by `POST` and `PATCH /v1/event-types` and both tools), so an agent's edit can never do what a person's could not.

## Questions are replaced, against a revision

`questions` is the whole list, in order, as the editor saves it. Replacing it from a stale read would remove a question a person added meanwhile, so it needs `if_revision`: a hash of the editable fields that `get_event_type` and `list_event_types` return as `revision`. A different one answers `CONFLICT` and changes nothing. A hash rather than a stored version means no migration: it changes whenever any editable field does, whoever changed it. It is compared on a fresh read just before the write, not under a lock, so two saves in the same instant can still both pass; the dashboard does not send one at all, so a person saving an editor opened earlier can overwrite an agent's edit, as they can another person's today.

Two kinds of question survive an agent's list. A `guests` question, which the tools neither add nor take, keeps its place, and its name stays taken. A question the CRM mapping reads keeps its name and type (`CRM_MAPPED_QUESTION` otherwise), checked against the list as it will be stored, guests questions included: the agent cannot see or repair the mapping, so removing or retyping that question would quietly stop the CRM from receiving its answer.

A read cleans what it shows (markup and hidden characters out, text capped), so an agent that reads, adds a question and sends the list back must not rewrite the host's own text. A label, placeholder or option it sends back exactly as a read showed it keeps the stored text, markup included, and is not checked again. An event type whose questions a read cannot show whole (more than 30 questions or 50 options, or text over 200 characters) refuses a question edit; its questions are edited in the dashboard.

## Who writes, and who may

The writer is a member of the account: the member a sign-in or OAuth connection acts as, with the role the account gives them now, or, for an API key, which belongs to the workspace, its oldest active owner (the one `whoami` names). A new event type is that member's own and follows their working hours. Team event types can be edited by owners and admins, and by keys without an event-type allowlist, never their hosts or assignment. A key held to some event types may update only those and may not create one.

How `event-types:write` is granted depends on the door:

- **API keys** get it from its own checkbox when they are created.
- **This API's own OAuth server** never grants it on a first connection. The first call that needs it answers 403 `insufficient_scope`, and the person approves it on the consent screen (step-up).
- **An external authorization server** has no scopes of ours, so a sign-in holds every MCP scope through the member's owner or admin role. There, the switch and the role are the gate: with the switch on, every owner and admin who signs in can edit event types through their agent.

## Created hidden

`create_event_type` makes the event type hidden unless the call passes `hidden: false`. A prompt-injected "create" then puts nothing on a public page; publishing is a second, visible step (`update_event_type` with `hidden: false`).

## A switch, an audit line, the usual limits

`MCP_EVENT_TYPE_WRITE_ENABLED` is off by default. Off, neither tool is listed, callable, or counted at the OAuth door, whatever scope a caller holds. The API reads it when it starts, so turning it on or off takes effect when the API process restarts. Every call counts against the write rate limit, takes an `idempotency_key`, and writes the usual audit line plus `changed`: the names of the fields it changed, never their values. A save that makes an event type visible records `event_type_published` with `source: mcp`. Nothing new is stored: no history table. A trail the host can read in the dashboard ("changed by this app") is a later question.

## Not in this decision

Working hours and schedules, single-use links, and every field kept out above. Each needs its own decision before it reaches the MCP.
