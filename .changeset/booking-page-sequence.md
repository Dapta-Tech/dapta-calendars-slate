---
'@slate/shared': minor
---

The event page is a sequence.

- On a phone one region owns the screen at a time: the event and the month,
  then the chosen day's times (the day as a sticky title, with the way back),
  then the details form (the chosen time restated at the top), then the
  confirmation. A 4px track says where you are, and each step slides in on one
  curve, still under reduced motion. From the two-pane width up the event sits
  on the left and the month with the day's times on the right, three across on
  a wide screen; the form replaces the right pane. The layout follows the width
  of its container, so an embed's frame and the studio's phone preview lay out
  as a phone does.
- No inner scroller: a long day makes the page longer. The time zone is a
  quiet control beside the times (and under the chosen time), and its list
  opens over a dimmed page on a phone. The `dayGroup` axis has something to
  draw again: the day's times are its group.
- The details form: 14px labels, 16px fields with 14/16 padding, the required
  mark beside the label, errors under the field, one 54px primary button.
- The confirmation says the event, the time in the visitor's own zone, the
  host and the place, and offers two actions: add to calendar (an .ics file
  with the booking's uid) and manage.
- The studio previews the real page rather than a drawing of it, and a spec
  renders both from the same config for every value of every axis.
- `@slate/shared` adds `formatDayLong` and `formatTimeRange`, and the booking
  page's new strings in English and Spanish.
