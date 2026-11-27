---
'@slate/calendar': minor
---

`CreatedEvent.cancelled` says a move came back with the event deleted on its calendar (the provider accepted the change and kept it deleted). New optional port method `eventExists` answers whether a written event is still on its calendar (`null` when the backend cannot tell); `UpdateEventInput.reportDeleted` lets a caller that can recover get a 404/410 as `cancelled`; `CalendarFeatures.eventLookup` gates lookups. The in-memory fake gains `removeOnCalendar` to simulate a host deleting an event by hand.
