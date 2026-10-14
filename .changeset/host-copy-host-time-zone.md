---
'@slate/db': patch
'@slate/notifications': patch
---

The host's copy of a booking email states the time in the host's own zone, and the invitee's copy in the invitee's, subject included. Every copy used to be formatted in the invitee's zone, so a host in Bogota booked by an invitee in Phoenix read "12:00 PM MST" for a meeting at 2:00 PM their time.

`loadBookingNotificationContext` now returns the host member's zone (`member.time_zone`, the zone the host's bookings page uses) as `host.timeZone`; the email payload snapshots it, and the new `recipientTimeZone` helper picks the reader's zone for every time variable and the legacy copy. A host row queued before the payload carried the zone reads it at delivery. Messages with no audience, and host payloads without a readable zone (forks that build notifications directly), keep the invitee's zone. Co-hosts share the host side's one message, so they read the organizer's zone. A member who has never set a zone is still on the `UTC` default (the dashboard sets it from the browser on first visit), so their host copies read in UTC, as their bookings page does; like every other snapshotted value, a row keeps the zone it was queued with. The `.ics` attachments are unchanged.
