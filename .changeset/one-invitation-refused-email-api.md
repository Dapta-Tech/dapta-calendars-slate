---
'@slate/api': patch
---

A guest whose dCal email is refused still gets one invitation. A refusal from the mail service (a suppressed recipient) is recorded once as `skipped` with its reason, instead of being retried for a day. When the refused email was the invitee's confirmation or reschedule and the host's event had been written without the provider's invitation, the provider now invites the guest after all, on the organizer's event: the guest is taken off quietly and put back with the provider inviting, same event and room. The follow-up is queued before the email row is recorded as ended, and the row is retried when it cannot be. A calendar delete looks at its cancellation email a few times and stays quiet only once the mail service has accepted it; otherwise it takes the email back (unless it is being sent) and leaves the provider's own cancellation. A move whose first booking row is gone still claims an .ics SEQUENCE above the fixed ones.
