---
'@slate/api': patch
---

A guest hears from the calendar provider once per change, retries included. Only the organizer's event notifies the guest: a co-host's copy is always written, moved and deleted with the provider quiet. A create or a move that an earlier attempt wrote quietly stays quiet on every retry, so if the invitee email never goes out the reinvite is the one provider invitation. The reinvite acts only for an invitee email that really ended unsent.
