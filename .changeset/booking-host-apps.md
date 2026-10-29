---
"@slate/web": minor
"@slate/api": minor
---

Booking pages can live on a host of their own (`PUBLIC_BOOKING_URL`, cloud: `book.<domain>`), apart from the dashboard, so the hosts' own tags never share an origin with a signed-in session. Inert until configured.

- The booking host serves every booking page (personal, team, one-off links, the invitee's manage page) and the shared paths (`/api/availability`, `embed.js`, build assets, icons), answers the dashboard's paths and `/` with a 307 to `PUBLIC_APP_URL` (404 for other methods), and keeps no dCal cookie.
- `BOOKING_HOST_REDIRECTS` (web): `temporary` (307) or `permanent` (308) makes every other host, older aliases included, redirect a booking page's GET or HEAD to the same path and query on the booking host. A POST is served where it lands, so an open tab keeps working, and an embed's frame is never redirected, so a customer site whose CSP allows only the old host keeps booking.
- Once the booking host is apart, the app host refuses a same-site request that is not a GET or HEAD, and a same-site subresource GET (an image, a script, a fetch) to the handlers that change the signed-in state (sign out, refresh, workspace reset and switch, developer skill); full-page navigations, such as the dashboard's own refresh chain after a click on the landing, are served.
- The links the app writes name the booking host: the manage link on every booking and in its emails, host-created bookings, book-again, MCP booking links (the MCP's sign-in text still names the dashboard), the dashboard's copy, open and embed snippets, and Open Graph URLs.
- Every workspace may load Google Tag Manager, Google Analytics and HubSpot once the booking host is apart (`EVENT_TRACKING_ACCOUNTS` stays for single-origin deployments), and the page starts them only on the booking host. The API hands that origin over with the ids (`trackingHostScriptsOrigin`). The web keeps them only when it matches its own `PUBLIC_BOOKING_URL` and starts them only on that origin (fail closed). With the setting on the API alone, or the two apart, the web drops their ids on the server and logs one warning. Set `PUBLIC_BOOKING_URL` on the web first, then on the API once every web instance has it; roll back in the reverse order.
