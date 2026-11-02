---
"@slate/api": patch
"@slate/web": patch
---

Three fixes found in production error tracking.

- The Calendars (connections) page no longer starts a calendar connect on every
  load. It asked `POST /v1/connections/token` whether sync was on, and with a
  provider wired each call ran the provider's real connect handshake: about 1.5 s
  per page view, provider-side state created each time, and the provider's rate
  limit spent until it answered 429. It now reads the new
  `GET /v1/connections/status`, which answers from configuration. A connect the
  host starts whose handshake fails answers 503 `CONNECT_UNAVAILABLE` instead of
  a 500 (the cause stays attached for error tracking and is logged), and the
  connect dialog closes its popup and shows its "try again" text instead of
  landing on the error page. Deploy the API with or before the web: an older API
  answers the new status route 404, and the page shows sync as off until it is
  out.
- The machine routes answer input the booking engine refuses with a 400 that
  names the field, as the public routes do, instead of a 500:
  `POST /v1/machine/bookings` (`attendees[0].email: Invalid email`),
  `GET /v1/machine/availability` (a malformed window, checked before the call so
  a fault in the service's own answer stays a 500), and an `Idempotency-Key`
  over 200 characters on bookings and `PATCH /v1/machine/bookings/:uid`.
- The "Checked <time>" caption on the Calendars page is written in the account's
  zone and the page's language. It was formatted with the runtime's zone, so the
  server render and the browser disagreed (React hydration error #418). A
  corrupt stored zone falls back to UTC there and on the integrations page,
  as the bookings pages already do, instead of crashing the render.
