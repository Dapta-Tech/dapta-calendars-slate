---
'@slate/shared': patch
---

Take the arrow glyphs out of the copy, and give the strings that became buttons
labels that stand on their own.

`backToBookings` carried a literal `← ` in both locales, which made a translator
responsible for a control's affordance. `calendarLinkConnect` ("Connect one") and
`noHandleLink` were written as sentence continuations under a `→`; on a button of
its own each now names its own destination. `manage.joinMeetingOpensNewTab` is new:
the join link's "(opens in a new tab)" was hardcoded English on a page whose locale
comes from the invitee's own link.
