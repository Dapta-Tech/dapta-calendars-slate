---
'@slate/web': patch
---

A host's Google Analytics 4 tag now counts embedded booking pages: its cookies are `SameSite=None; Secure; Partitioned`, so a booking page framed on another site sends its page view and `booking_scheduled` in browsers that accept partitioned cookies (Chrome, also with third-party cookies blocked), with one client id per embedding site.
