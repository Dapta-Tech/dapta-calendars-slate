---
'@slate/db': patch
'@slate/notifications': patch
---

A hold on a time is exclusive even when visitors pick it at the same moment, and the per-page cap on active holds holds under concurrency (`reserveSlot` re-checks overlap and the cap inside a transaction on the host's row). The host's copy of a booking request asks the host to confirm or decline, instead of wearing the invitee's words and the invitee's "Cancel request" button.
