# A host event is a booking with no event type

A host's own AI agent can now put events on the host's own calendar through the MCP (`create_event`): "block this afternoon to study", "a 1:1 with Daniel", "a one-hour call called Phone with three people". These have their own title, any time and length, and the people the host chooses. No event type fits them: an event type is something other people book, with hours, notice and a slot grid.

They are stored as `booking` rows with `event_type_id` NULL. Every other write names an event type, and deleting an event type leaves its id on its bookings, so NULL marks a host event and nothing else; no column or migration is added. Being a booking is what makes the rest work without a second model: `list_bookings` and its `updated_since` feed list it, `get_booking` reads it, `reschedule_booking` and `cancel_booking` move and remove it, and the calendar write-out, the outbox and the overlap guard treat it as they treat any booking. The paths that assumed an event type were changed to read one only when there is one (the v2 booking reader, the v2 and v1 reschedule, group-event busy, the MCP list and summaries).

Three rules follow from "a booking the host made for themselves":

- **The overlap guard is the same.** A host event is written under the host's lock with the same overlap check, and Postgres's `booking_no_overlap` covers it, so it can never overlap another dCal booking of the same host. What the host may choose to ignore (`allow_conflicts`) is only what dCal does not own: busy time on the connected calendar and another caller's hold. Overriding a dCal booking would mean weakening the guard every booking relies on.
- **Nobody is emailed by dCal.** The host made it; the connected calendar invites, updates and cancels its attendees. Every booking email (confirmation, move, cancellation, reminders, follow-ups), the booking webhooks and the CRM write-out skip a booking with no event type, at their single entry points. Booking webhooks and CRM are about meetings someone booked, and a subscriber must not get the host's focus blocks.
- **It rides on `bookings:write`.** Creating an event writes to the host's calendar the way booking does, so it needs the scope that already lets an agent create, move and confirm bookings, not a new one. The difference is that the title, body and time are free text rather than an event type's: a key or connection granted `bookings:write` can now put such an event on its host's calendar and invite any address (`create_booking` guests could already invite any address). Two limits keep that inside what the grant means: a key held to some event types is refused, since an event of the host's own is outside those types; and an API key, which belongs to the workspace rather than a person, acts only for the workspace's owner, never for another member. A separate scope can be split off later without changing the tool.

A sign-in acts for its own member. Later questions this does not answer: checking the attendees' own calendars, all-day events, a location (the calendar port has no field for one), and a webhook trigger of its own (`event.*`) if a subscriber wants host events.

## Follow-up

[ADR 0012](0012-a-repeating-event-is-one-calendar-series-and-dated-bookings.md)
implements repeating host events and attendee availability. The earlier
open questions above record the scope when this decision was made.
