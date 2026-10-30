---
'@slate/web': patch
---

A host's Google Analytics 4 tag now counts embedded booking pages: its cookies are `SameSite=None; Secure`, so a booking page framed on another site sends its page view and `booking_scheduled` instead of nothing.
