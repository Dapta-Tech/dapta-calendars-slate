---
'@slate/calendar': minor
'@slate/notifications': minor
'@slate/db': minor
---

One invitation per booking. `CreateEventInput`, `UpdateEventInput` and `DeleteEventInput` gain an optional `sendInvitations`: `false` asks the calendar backend to write the event without the provider's own invitation, update or cancellation email, because this service emails the invitee its own .ics. `BookingNotification.calendarUid` (filled from the new `BookingNotificationContext.calendarUid`, found by `rescheduleChainRoot`) keeps a booking moved to a new uid on the .ics UID of its first booking, and the .ics SEQUENCE now always grows: 0 on a first confirmation, then the seconds from 2026-01-01 to the moment the notification was queued. `CalendarWriteContext` gains optional `accountId` and `otherGuestCount`.
