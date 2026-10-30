---
'@slate/api': patch
---

The host's calendar event is written without the provider's own invitation only when the invitee's email for that change is in the outbox and the mail transport delivers, so a guest gets one invitation and one cancellation, not two, and never none. A booking with no location at all is an online meeting: the organizer's calendar is asked for a room and the confirmation waits for its link. Every move and cancellation .ics carries a higher SEQUENCE than the last. Deleting an event the backend already lost (404 or 410) counts as done.
