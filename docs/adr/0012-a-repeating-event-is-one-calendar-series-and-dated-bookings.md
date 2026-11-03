# A repeating event is one calendar series and dated bookings

A host's agent can now put a repeating event on the host's calendar ("a weekly Dapta Phone on Wednesdays at 15:30 with Fausto, Cele, Daniel and Jonathan, with a video link"), check first when those people are free, and get the video link back. This builds on [ADR 0011](0011-a-host-event-is-a-booking-with-no-event-type.md): a host event is a booking with no event type.

## How a series is stored

A series is two things kept in step.

- **One repeating event on the host's calendar.** The attendees get one invitation for the series, not one per date, and see one series in their own calendars. The calendar port carries the rule twice: as fields (frequency, interval, weekdays, count or last date, first date, zone) for a provider that takes a pattern, and as an RFC 5545 RRULE for one that takes that. The event is written through the outbox like any other calendar write.
- **Its dates as bookings.** Each date is an ordinary host-event `booking` row linked to its series by `booking.recurring_event_id` (a column that existed and was never written). The series itself is a row in a new `host_event_series` table: the rule, the attendees, the dates it skipped, how far ahead its dates are written, and the calendar event's ids.

Dates are bookings so that **every date blocks the host and is guarded like a booking**. Availability, the overlap check under the host's lock, and Postgres's `booking_no_overlap` all see each date with no new code. A series can never double-book the host. Computing the dates on the fly in every read was rejected: it would leave the `EXCLUDE` constraint blind to them.

## Open-ended series: a rolling horizon

A series with no end cannot be written as rows forever. Dates are written **180 days ahead** (`SERIES_HORIZON_DAYS`). A job (`SeriesExtender` in the API, every hour on every replica) moves each active series' horizon forward and writes the dates that came within it. Each date is written under one key per series and date (`booking.idempotency_key` is unique) and under the host's lock, so replicas running the job at once never write a date twice. A series whose rule has no dates left is marked `ended`.

Beyond the horizon, the host is protected by the calendar. The repeating event is on the host's calendar, and every booking reads that calendar fresh and fails closed (ADR 0009), so a time it covers is not offered. A date that still meets a dCal booking when the job reaches it (a series kept only in dCal, or a calendar that could not be seen) is skipped. That date is cancelled on the calendar and recorded on the series. A host event never displaces a booking someone made.

## Conflicts are reported by date

Creating a series checks every date over the horizon, exactly as a single event is checked:

- **Another dCal booking** on a date refuses the series with `SLOT_TAKEN`, naming the dates. `allow_conflicts` never overrides it.
- **Busy time on the connected calendar, or a hold**, refuses it with `CONFLICT`, naming the dates and what is there. `allow_conflicts` writes the series over them.
- **An unreadable calendar** refuses with `CALENDAR_UNAVAILABLE` unless `allow_conflicts`; the answer then says the dates were not checked.
- **`skip_conflicting_dates`** writes the series without the dates that have something in the way, and the answer lists them. The calendar event leaves them out too (`excludedStartsUtc`).

Later dates written by the job are not checked against the calendar. The host accepted the series when it was made, and the calendar already shows the series' own future dates as busy.

## Wall clock and DST

A series is anchored to a **wall clock in one zone**: the first date, a local start time and a length. The zone is `time_zone` or the host's own. Every date starts at that local time, whatever the UTC offset that day. A weekly 15:30 stays at 15:30 across a DST change, as the calendar that holds it shows it. A local time that a DST change skips is read with the offset from before the gap, as RFC 5545 says and as Google and Microsoft do: 02:30 on a day that jumps from 02:00 to 03:00 becomes 03:30. dCal blocks the instant the calendar shows. The rule is pure code in `@slate/engine` (`recurrence.ts`): the dates, the RRULE, and the checks that a rule is valid. It is unit-tested across DST changes.

## Idempotency

The series is written under the caller's `idempotency_key`, namespaced by credential like every keyed write. A retry with the same key and arguments answers the same series, with the same dates, skips and overrides as the first call. The same key with other arguments is refused. Moves and cancellations of a series are idempotent by state: moving a series to where it already is, or cancelling from a date it is already cancelled from, changes nothing and says so.

## Changing a series: one date, this and following, or the whole series

`cancel_booking` and `reschedule_booking` take a `scope` for a date of a series:

- **`this`** (the default): that date only, exactly as any booking is moved or cancelled. On the calendar, only that occurrence changes. The port's `occurrenceStartUtc` names it by its original start, so a date moved before can still be found.
- **`this_and_following`**: that date and every later one. A cancel ends the rule the day before: the calendar's event is cut there, and deleted when nothing of it would remain. A move ends the old series the day before and continues as a new series from the new time, which the attendees get as its own invitation. Moving from the series' first date moves the whole series in place instead, and the attendees see it move.
- **`series`**: every date that has not started. Dates already past stay as they were; nobody wants their history rewritten. With nothing past, this is the same as `this_and_following` from the first date.

A move shifts each later date the way the chosen date moved, in local time: the new time of day, and the same number of days, so "Wednesdays" moved one day later become "Thursdays".

The dashboard's cancel on a date of a series offers the same three choices and calls the same code, so a series cancelled there is cancelled exactly as through the MCP. The dashboard has no reschedule, so a series is moved only through the MCP. Cancelling removes the event from the attendees' calendars too: the host's calendar sends the cancellation. dCal sends nobody an email, a webhook or a CRM write for any of this, as in ADR 0011.

## A connection says what it can do

dCal's calendar code is vendor-neutral (R15); the provider calls live in a backend behind the port. A backend that ignored the new recurrence fields would write one lone event, and the attendees would be invited to one date. So a connection now declares its **features** (`CalendarProvider.features`): `recurrence`, `attendeeFreeBusy`, and `conferencing`. A backend that declares nothing has single events and the conferencing the contract always had. dCal refuses a repeating event for a connection without `recurrence` (`RECURRENCE_UNSUPPORTED`) instead of writing anything. A calendar job for a series on such a connection is skipped, never written as a single event. The generic REST backend declares its features through `CALENDAR_BACKEND_FEATURES`. A private overlay declares its own, per connection.

## Video created by the calendar

`video_link: true` already asked the host's connected calendar to create the meeting room (a Google Meet through `conferenceData`, a Microsoft Teams meeting through `isOnlineMeeting`), through the port's `requestConferenceLink`. `create_event` now returns the link. A host event has no invitee email to wait for (ADR 0007), so its calendar write is due at once. The tool waits a few seconds for it and answers `meeting_url`. If the calendar has not answered by then, the link is null with `video: "pending"`, and `get_booking` shows it once written. A series has one room for all its dates.

## Attendee availability: a new tool, not `find_team_slots`

The caller can ask when the host and a list of people are all free, with a new read-only tool, `check_attendee_availability`. It works at a given time (once, or on the dates of a repeating rule: "every Wednesday at 15:30 for the next five weeks"), or over a window, where it lists the times everyone it can see is free. It reads through the host's own connection: Google's free/busy query, Microsoft's `getSchedule`, through the port's optional `listAttendeeBusy`. The host's own busy time is dCal's bookings, holds and calendar, read fresh.

A calendar the provider will not show (another organization, sharing off, no such calendar) comes back **unknown**, with the reason, **never free**. The answer says whose calendars could not be seen.

`find_team_slots` was not extended. It answers a team **event type**: its hosts are dCal members, and its times come from the event type's hours, notice, buffers and slot grid. None of that applies to a meeting with arbitrary email addresses, and folding both into one tool would give it two unrelated input shapes. The new tool needs `availability:read`. Like `create_event`, it acts for the signed-in member, or for an API key the workspace owner, and refuses a key held to some event types.

## No new OAuth scope

All of this works under the scopes the connections already ask for (checked 2026-11-03). Google's calendar scope covers RRULE events, `conferenceData` and the free/busy query of other calendars. Microsoft's `Calendars.ReadWrite` covers recurrence patterns, online meetings and `getSchedule`. No user has to reconnect.

## Not in this version

These are not covered yet:

- monthly and yearly rules;
- all-day events;
- a location;
- changing a series' attendees, title or length after it is made;
- a webhook trigger for host events.
