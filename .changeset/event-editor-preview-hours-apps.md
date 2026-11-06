---
"@slate/web": minor
"@slate/shared": minor
"@slate/db": minor
"@slate/api": minor
"@slate/notifications": minor
---

The event type editor has an eye button (create and edit) that opens the unsaved draft as the booking page in a new tab (`/preview/event`), in the host's own look and fully clickable: a saved personal event shows its real times (the host's own availability read), new and team events show example times, and the form shows the event's questions. In preview mode (`BookingFlow`'s new `previewNotice`) picking a time holds nothing and a valid submit books nothing; it says so instead. The draft travels through localStorage, never the URL.

Each reminder and the follow-up has an eye button that opens the email exactly as an invitee would receive it: From, To and Subject, then the branded HTML, rendered by the API's own notifier from the row's unsaved copy and a sample booking (`POST /v1/event-types/reminder-preview`, which renders only; nothing is stored or sent). A blank subject or message previews the shipped default wording. `BookingNotifier.previewReminder` renders through the same builders `sendReminder` and `sendFollowUp` use.

A personal event's bookable hours come from the host's working hours (shown read-only, with a link to edit them), a saved schedule, or custom hours of its own, edited as rows of day (or Every day, Weekdays, Weekends) → from → to, with + Add hours and delete. Custom hours start from the working hours, are checked like the API checks them (at least one row, end after start, no overlaps), and save as `customHours`; team events keep their hosts' hours.

`GET /v1/schedules` marks the member's default schedule with `isDefault` (additive). The reminder lead wording (`formatLead`) moves to `@slate/shared`; `@slate/notifications` re-exports it unchanged. `previewFlowProps` takes the event's description, length, location and questions (the studio's sample is unchanged), and the booking-page studio reads its look through the new `bookingLookOf`. The editor's tabs and buttons show a pointer cursor.
