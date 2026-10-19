---
'@slate/engine': minor
'@slate/notifications': minor
'@slate/db': patch
---

One template language for everything a host writes that is sent to someone, starting with email. `@slate/engine` gains a logic-less, single-pass template engine and its variable catalog (as data, EN/ES labels and samples): `{{variable}}`, the short aliases `{{name}}`, `{{first_name}}` and `{{email}}`, `{{form.<question>}}`, a fallback for an empty value (`{{attendee_first_name | "there"}}`) and blocks shown on an answer (`{{#if form.company}}...{{/if}}`, `{{#if form.plan == "Pro"}}...{{else}}...{{/if}}`, also `!=` and `contains`). It is a superset of the email templates that shipped before: every template that renderer could read renders byte for byte as it did (a spec compares the two), the empty-line rule included. A block that does not pair up prints as written, like any tag the first renderer could not read. The short aliases now resolve where they used to render empty.

It is safe by construction: no expression language, no raw output, a value is never parsed again (an answer that contains `{{...}}` prints those characters), names are own properties only, every value loses control and bidi characters and is length-capped, and the output is plain text that each sink escapes for its own format.

Email now renders through it. New variables: `attendee_first_name`, `attendee_phone`, `guests`, `attendee_time_zone`, `host_email`, `event_name`, `event_description`, `duration`, `workspace_name`, `team_name`, `start_time_host`, `end_time_host`, `start_time_attendee`, `end_time_attendee`, `time_zone` and `booking_uid`. `{{form.*}}` resolves in every email, not only in reminders, and reads only the event's own questions (an undeclared answer key never reaches mail). `{{guests}}` is host-only: it resolves in the host's copy and is refused in invitee copy, since on a group event the other people on a booking are strangers to each invitee. The invitee's phone is snapshotted into a copy only when its template reads it. `loadBookingNotificationContext` returns the event type's name and description, the account's name and the owning team's; rows queued before them read the event name as the booking title and the rest as empty.

A template is checked when it is saved: Settings → Notifications and an event type's reminders refuse an unknown variable, one that copy cannot read or a broken block with a 400 (`INVALID_TEMPLATE`) that lists every problem with its field, reminder id and offsets, in the host's language. A text already stored passes unchanged (line endings aside), so no existing template blocks an unrelated save. The preview returns the same `issues`.

Copy that uses blocks or fallbacks needs this version to render: during a rolling deploy or after a rollback, an older worker sends those tags as written.

The email layout uses the one HTML escaper (`escapeHtml`, which also escapes `'`), and the `.ics` TEXT escaper folds a lone CR.
