---
'@slate/db': patch
---

`CalendarChangeMark` gains `organizerMoved`: a move written without the provider's invitation has already moved the organizer's event, so a retry that saves it at the same time notifies nobody and the reinvite must still run.
