---
'@slate/shared': minor
---

Add the month-calendar and hour-format helpers the public event page's three-region
layout needs.

- `buildMonthGrid`, `monthKeyOf` and `shiftMonth` lay a month out as whole weeks of
  `{ dayKey, dayOfMonth, inMonth, isToday, isPast, hasSlots }`. They work on
  `YYYY-MM-DD` day keys already resolved in the visitor's zone, so the one
  timezone-sensitive step stays in `zonedDayKey` and the grid is pure calendar
  arithmetic.
- `formatSlotTime`, `formatSlotDateTime` and `groupSlotsByDay` take an optional
  `hour12`, which is the booking page's 12h/24h toggle. Left unset, the locale
  decides, so every existing caller renders exactly as before.
- New: `zonedTodayKey`, `formatDayKeyLong`, `formatMonthLabel`, `weekdayLabels`,
  `weekStartsOnFor`.
- New `bookingPage` i18n block (`en` + `es`) for the layout's own copy: region
  names, month navigation, the day column's empty states and the hour toggle.

All additive; no existing signature or message key changed.
