---
'@slate/engine': minor
'@slate/notifications': minor
'@slate/db': patch
---

One template language for everything a host writes that is sent to someone, starting with email. `@slate/engine` gains a logic-less, single-pass template engine and its variable catalog (as data, EN/ES labels and samples): `{{variable}}`, the short aliases `{{name}}`, `{{first_name}}` and `{{email}}`, `{{form.<question>}}`, a fallback for an empty value (`{{attendee_first_name | "there"}}`) and blocks shown on an answer (`{{#if form.company}}...{{/if}}`, `{{#if form.plan == "Pro"}}...{{else}}...{{/if}}`, also `!=` and `contains`). It is a superset of the email templates that shipped before: every saved template renders as it did, the empty-line rule included.

It is safe by construction: no expression language, no raw output, a value is never parsed again (an answer that contains `{{...}}` prints those characters), names are own properties only, every value loses control and bidi characters and is length-capped, and the output is plain text that each sink escapes for its own format.

Email now renders through it. New variables: `attendee_first_name`, `attendee_phone`, `guests`, `attendee_time_zone`, `host_email`, `event_name`, `event_description`, `duration`, `workspace_name`, `team_name`, `start_time_host`, `end_time_host`, `start_time_attendee`, `end_time_attendee`, `time_zone` and `booking_uid`. `{{form.*}}` resolves in every email, not only in reminders. The phone and the other guests are snapshotted into a copy only when its template reads them. `loadBookingNotificationContext` returns the event type's name and description, the account's name and the owning team's; rows queued before them read the event name as the booking title and the rest as empty.

A template is checked when it is saved: Settings → Notifications and an event type's reminders refuse an unknown variable, one an email cannot read or a broken block with a 400 that lists every problem with its offsets. A text already stored passes unchanged, so no existing template blocks an unrelated save. The preview returns the same `issues`.

The email layout uses the one HTML escaper (`escapeHtml`, which also escapes `'`), and the `.ics` TEXT escaper folds a lone CR.
