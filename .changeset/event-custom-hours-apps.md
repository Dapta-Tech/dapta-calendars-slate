---
"@slate/api": minor
---

`/v1` event types accept and return `customHours` (an event's own weekly hours); a save with both `customHours` and `scheduleId`, custom hours on a team event type, or a `scheduleId` that is not a reusable schedule of the same account (and, for a personal event, of its own host) is refused with 400. Private schedules never show through `/v1/schedules`. See `event-custom-hours.md` for the data side.
