---
"@slate/web": minor
"@slate/shared": minor
"@slate/db": minor
"@slate/api": minor
"@slate/notifications": patch
---

The event type editor shows a live preview beside the form on wide screens (behind a Preview button below that): the real booking page island, inert, drawn from the unsaved draft in the host's own look, inside a browser frame with the event's public address. On the Reminders tab it shows the chosen reminder as the attendee reads it, its variables filled with sample values; a blank subject or body says it uses the default wording. Settings the sample page does not draw are named under it.

A personal event's bookable hours come from the host's working hours (shown read-only, with a link to edit them), a saved schedule, or custom hours of its own, edited as rows of day (or Every day, Weekdays, Weekends) → from → to, with + Add hours and delete. Custom hours start from the working hours, are checked like the API checks them (at least one row, end after start, no overlaps), and save as `customHours`; team events keep their hosts' hours.

`GET /v1/schedules` marks the member's default schedule with `isDefault` (additive). The reminder lead wording (`formatLead`) moves to `@slate/shared` so the emails and the preview word it the same; `@slate/notifications` re-exports it unchanged. `BookingPreview` and `previewFlowProps` take the event's description, length, location and questions (the studio's sample is unchanged), and the booking-page studio reads its look through the new `bookingLookOf`.
