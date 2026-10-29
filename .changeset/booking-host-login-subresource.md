---
"@slate/web": patch
---

Starting a sign-in (`/api/auth/login`) is now one of the GETs another host of
the same site may only reach as a full-page navigation: an image, a fetch or a
frame placed by a page on the booking host gets a 403 on the app host. The
login sets the short-lived OAuth state cookie, and the callback's only binding
is that the cookie exists, so a sign-in started by a booking-page tag could
otherwise be finished with a session of the tag's choosing (login CSRF). It
changes nothing until `PUBLIC_BOOKING_URL` names a booking host.
