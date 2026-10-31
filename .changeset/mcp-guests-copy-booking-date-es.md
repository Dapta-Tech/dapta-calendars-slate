---
"@slate/api": patch
"@slate/web": patch
---

Two corrections found while documenting dCal.

- MCP `create_booking` no longer says each extra guest is emailed. dCal's own
  emails go to the invitee and the host, never to a guest; the host's connected
  calendar, when there is one, is what invites the guests. The tool description and the
  `guests` argument now say so. New `mcp.create-booking-guests.spec.ts` checks
  the text and, with the real notifier, that no copy of a booking email goes to
  a guest.
- A booking's date in the dashboard is written in the reader's language: the
  bookings list, a booking's own page and the new-booking form's times read
  "jue, 19 nov, 18:00 GMT-5" for a Spanish reader instead of always US English
  (`dateLocale` in `booking-parts.tsx`). English stays exactly as it was.
