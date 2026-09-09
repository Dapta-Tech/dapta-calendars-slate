---
"@slate/types": minor
---

Name the manage view's reschedule context by the kind of event type that owns
the booking, so a team booking can be rescheduled at all.

`bookingViewSchema.reschedule` is now a union of a team context
(`{ kind: 'team', accountCode, teamSlug, slug }`) and the personal one
(`{ kind?: 'personal', accountCode, handle, slug }`). It used to be the personal
shape only, so a team booking was described by the assigned organizer's handle
alongside the team event slug — a context that reads as valid but resolves to
nothing, because a team event type has `member_id NULL` and `team_id` set. The
manage page called the personal availability route, got nothing back, and
rendered an empty picker: a team invitee could cancel but never reschedule.

Additive. `kind` is optional on the personal branch, so a v1 body
(`{ accountCode, handle, slug }`) still parses and still means personal, and the
two branches stay disjoint on `handle` vs `teamSlug` even without the
discriminant.
