---
"@slate/web": patch
---

On the booking host, the app's own route handlers (`/api/*`, except the shared `/api/availability`) answer 404 for every method instead of a GET being sent on to the app host. No link names a route handler on the booking host, so nothing that worked stops working. A booking page's script can no longer reach sign-in, sign-out or any other handler by way of the booking host. On the app host, the sign-in callback joins the GETs another host of the same site may reach only as a full-page navigation (the identity service's return trip is one): a script's fetch or image to it gets a 403, so a sign-in a tag started cannot be finished with a session of the tag's choosing. It changes nothing until `PUBLIC_BOOKING_URL` names a booking host.
