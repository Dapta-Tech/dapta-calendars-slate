---
'@slate/calendar': minor
'@slate/notifications': minor
'@slate/db': minor
---

One invitation per booking. `CreateEventInput`, `UpdateEventInput` and `DeleteEventInput` gain an optional `sendInvitations`: `false` asks the calendar backend to write the event without the provider's own invitation, update or cancellation email, because this service emails the invitee its own .ics. `BookingNotification.calendarUid` (filled from the new `BookingNotificationContext.calendarUid`, found by `rescheduleChainRoot`) keeps a booking moved to a new uid on the .ics UID of its first booking, and `BookingNotification.icsSequence` carries a SEQUENCE claimed per change from a new atomic counter (`booking.ics_sequence`, migration 0038 on Postgres and 0037 on SQLite, `claimIcsSequence`); without it the fixed 0 / 1 / 2 stand. `CalendarWriteContext` gains optional `accountId` and `otherGuestCount`.
