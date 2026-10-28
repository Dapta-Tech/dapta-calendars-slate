---
"@slate/db": minor
"@slate/engine": minor
"@slate/types": minor
"@slate/shared": major
---

An event type can send the invitee to an external page once a booking is made, instead of leaving them on the confirmation. A new nullable column, `event_type.success_redirect_url` (Postgres migration 0034, SQLite 0033, additive, bounded by `lock_timeout`), holds an absolute https URL; NULL, every existing event, keeps the confirmation exactly as it is.

Only `https://` addresses with a host and no credentials are accepted, at most 2048 characters: `javascript:`, `data:`, plain `http://` and every other scheme are refused when the event is saved, and the booking page refuses to follow them whatever a read returns. The URL is passed as the host saved it, with nothing about the booking or the invitee added. Reschedules and cancellations never redirect.

The address goes only to an invitee who booked: the public booking writes (personal and team) answer it as `successRedirectUrl`, read after the booking commits, and no availability read carries it.

`@slate/engine` adds `isSuccessRedirectUrl` and `MAX_SUCCESS_REDIRECT_URL` (re-exported by `@slate/types`); `@slate/types` adds `successRedirectUrl` to the event type input and to the booking view, and `successRedirectUrlSchema`; `@slate/db` reads and writes it and adds `getBookingSuccessRedirectUrl`; `@slate/shared` adds the EN and ES copy (`admin.eventTypes.successRedirect`, `bookingPage.redirecting`, `bookingPage.redirectContinue`).
