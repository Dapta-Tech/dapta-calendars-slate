# Event type editor

dCal is Calendars for AI agents. Event types define what invitees and agents
can book: the meeting's duration, hours, intake questions, reminders and calendar
text. Open **Events** in the dashboard, then create an event or edit one.
These instructions describe the editor on `develop`.

## Choose the right tab

| Tab | Use it for |
|---|---|
| **General** | Title, event link, duration, location, calendar text, availability, hosts, booking rules, after-booking behavior, visibility and sharing. |
| **Booking form** | Questions the invitee answers. |
| **Reminders** | Each reminder and follow-up email's enabled state, timing and text. |
| **CRM Connection** | The event's CRM settings and booking-answer mappings, when available. |
| **AI Agents** | The saved event ID and how an agent connects to book this event. |

**CRM Connection** appears when the deployment has CRM or tracking settings
available. **AI Agents** is read-only guidance; an event ID appears after the
event is first saved.

The editor keeps a single draft across the tabs. Switching tabs does not save
it. Use the save or create action when you are ready. Leaving a changed draft
asks whether to discard those changes.

## Set meeting notice and booking rules

In **General**, choose **Duration** and **Minimum notice**. Notice offers 1, 2,
6 or 12 hours, or 1 through 5 days. A previously saved value outside those
choices, such as 30 minutes, stays available when you edit that event.

Expand **Advanced settings** for buffers before and after a meeting, group
seats, the booking window and how often start times are offered. Notice and
these rules still apply when an agent books an event type through MCP.
`create_event` is a different action for the host's own calendar and does not
use an event type's slot grid or notice.

## Give a personal event its own weekly hours

Under **General**, find **Availability**, then **Bookable hours**:

1. Choose **My working hours** to follow your Availability page, or **A saved
   schedule** to reuse a schedule.
2. For a personal event, choose **Custom hours for this event** to set hours
   just for this event. Select the time zone, days and start/end times.
3. Use **Add hours** for another row, for example weekdays 09:00 to 12:00
   and weekdays 14:00 to 17:00. End each row after its start; rows on the
   same day must not overlap.
4. Save the event.

Custom hours are stored on the event type and are not added to the reusable
schedules on Availability. The first switch to custom hours starts from your
weekly working hours; date-specific overrides are not copied. Team events do
not offer this custom-hours option and continue to consider each host's hours.
Connected-calendar busy time and existing bookings still block a time inside
these hours.

## Personalize calendar text

In **General**, under **In the calendar**, edit **Calendar event title** and
**Calendar event description**. Click or drag a variable from the palette into
the field, or type its token, such as `{{attendee_name}}`.

For example, `{{event_title}} with {{attendee_name}}` puts the meeting and
invitee names in the title. A booking question named `company` can appear as
`{{form.company}}`. Add that question under **Booking form** first. The example
under each field uses sample values, not a real booking.

Leaving the title template empty uses the event title. Leaving the description
template empty adds no description. The resolved title is used in the host's
and invitee's calendars and booking emails. Different fields accept different
variables; the palette follows the last field you selected. Calendar fields
do not accept email-only links such as `{{manage_url}}` or `{{meeting_url}}`.

An event with group seats shares one calendar event. Its templates cannot use
one invitee's personal details or booking-form answers. The editor removes
those choices from the palette and rejects them if typed manually.

Template implementation and validation live in
`packages/engine/src/template-catalog.ts`, `template.ts` and
`template-calendar.ts`; the API applies them when it creates a booking.

## Preview an unsaved booking page

Use the eye button, **Preview booking page**, in the editor header. It opens
`/preview/event` in a new tab with the draft title, description, duration,
location and booking questions. You can try the form without creating a meeting.

For an existing personal event, times come from its real availability **as last
saved**. Unsaved changes to hours and booking rules do not recalculate those
times. New events and team events use example times. Save the event before
checking its actual public availability.

The draft is passed through browser storage with an opaque key in the URL;
typed draft content is not placed in the URL. If storage is blocked or the
preview has no draft, reopen it from the editor.

## Preview a reminder or follow-up

Under **Reminders**, use the eye button, **Preview email**, on the row you want
to check. It renders that row's unsaved subject and body with the event draft,
a sample booking and the account's email branding. The modal shows the subject,
recipient and, when available, sender.

This sends no email. The preview explains that your custom message is sent as
plain text within the email design. Reminder and follow-up choices apply to
bookings made on the event type. Host events made with `create_event` send no
dCal booking emails; their connected calendar handles attendee invitations.

## Fix a save error

A failed save shows a summary above the tabs and a count on each affected tab.
Select a field error in the summary to open its tab, expand its section when
needed and focus the field. Fix each message, then save again. An API error
without a specific field appears in the summary as text.

## Choose a workspace

If your account has access to several workspaces, check the workspace selector
before editing. For operator logins, the account picker shows the organization name returned
by the identity service, including accounts found through search. A missing name
falls back to the account code or default picker label. A displayed name does
not grant access: the API still checks each workspace switch.

## Related

- [MCP tools and access](MCP.md)
- [Self-hosting configuration](../SELF-HOSTING.md)
- [Workspace membership decision](adr/0010-who-and-where-are-two-questions.md)
