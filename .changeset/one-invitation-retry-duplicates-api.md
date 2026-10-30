---
'@slate/api': patch
---

A guest hears from the calendar provider once per change, retries included. Only the organizer's event notifies the guest: a co-host's copy is always written, moved and deleted with the provider quiet. A retry clears the record of a quiet write only when the organizer's event really notified the guest (a create of it, or a move an earlier quiet attempt had not already made), so the reinvite never adds a second invitation and still runs when the retry's save notified nobody. The reinvite acts only for an invitee email that really ended unsent.
