---
"@slate/web": minor
"@slate/shared": minor
---

The event type editor has an "In the calendar" section: the calendar event's title and description as templates (`Intro Call – {{attendee_name}} ({{form.company}})`), so each booking is named after who booked and what they answered. Each field has an "Insert variable" menu (the booking form's answers first, then the catalog's invitee, host, event and time variables allowed in that field; nothing about one invitee on an event with seats) that inserts at the caret, and a live example rendered with sample values. Templates are checked in the editor with the engine's own validator, the same one the API applies, and an API refusal points at its field. Blank keeps the event title and no description. The API already stored and rendered `calendarTitleTemplate` / `calendarDescriptionTemplate`; this is their editor. EN and ES copy under `admin.eventTypes.editor.calendarText`.
