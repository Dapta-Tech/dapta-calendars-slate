---
"@slate/web": minor
"@slate/api": minor
---

The event type editor has "Booking limits" under Advanced settings (personal and team events): max bookings and max total minutes, per day and per week, each empty for no limit and checked beside its field (a minutes limit at least the event's length). A day the limits closed shows "Full" ("Completo") on the booking page instead of a blank day: the availability response lists those times as `fullSlots`. `/v1` event types read and write `maxBookingsPerDay`, `maxBookingsPerWeek`, `maxMinutesPerDay` and `maxMinutesPerWeek`, refusing a minutes limit shorter than the event (also when a save raises the length past it); `/v2` lists them as cal.com's `bookingLimitsCount` and `bookingLimitsDuration` (`{ day?, week? }`, or null); the MCP `get_event_type` shows them as `max_bookings_per_day` and the rest. A booking, hold or reschedule refused because a day or week is full keeps its error code and says so ("That day has reached this event type's booking limit"), on REST and through MCP; `hold_slot` says a hold reserves no place against a limit. See `event-booking-limits.md` for the data and engine side.
