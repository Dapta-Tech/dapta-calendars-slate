---
"@slate/db": minor
"@slate/notifications": minor
"@slate/types": minor
"@slate/shared": patch
---

Move reminders and the follow-up from the account to the event type.

Each event type carries a list of `{ id, kind, enabled, leadMinutes, subject, body }`
rows on the new additive `event_type.reminders` column: every reminder has its own
switch, its own lead time and its own copy, capped at 10 plus one follow-up. A new
event type is born with 24h + 1h enabled and the follow-up off.

Reminder copy can quote the event's own intake answers through a new
`{{form.<field name>}}` namespace. The prefix is what keeps a question named
`location` from shadowing the built-in `{{location}}`, so no new names are reserved
and existing saved forms keep working. An unanswered or deleted question renders
empty and its line is dropped, exactly as an absent built-in already does.

Existing event types are given a copy of their account's current lead times and copy
by an idempotent migration fixup, so no host loses configuration and no invitee's
mail moves. `attendee_reminder`, `host_reminder` and `follow_up` are no longer
listed or editable in Settings → Notifications; the 9 transactional keys are
unchanged. The host side of a reminder keeps its shipped template — the row's
subject and body are the invitee copy.

Two consequences worth stating. Host-side reminder *copy* stops being editable
(its lead time and its on/off become per-event, which is the upgrade). And a
stored `host_reminder: disabled` survives as a legacy **mute** on the host side —
it can silence, never enable — so a host who had turned their own copies off does
not start receiving them again; an account that never touched it is unaffected.
