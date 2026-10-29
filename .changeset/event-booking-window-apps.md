---
"@slate/web": minor
"@slate/api": minor
---

The event type editor has a "Booking window (days)" field (personal and team events), empty for no limit and checked as you leave it. Days past the window have no times on the booking page, so they show the way unavailable days already do. `/v1` event types read and write `bookingWindowDays`, and `/v2` lists it as cal.com's `bookingWindow` (`{ type: "calendarDays", value, rolling: false }`, or null). See `event-booking-window.md` for the data and engine side.
