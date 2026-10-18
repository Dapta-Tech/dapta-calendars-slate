---
'@slate/db': minor
'@slate/notifications': minor
'@slate/config': minor
'@slate/types': minor
'@slate/shared': minor
---

The host's copy of a booking email says who is asking and what they answered, and the invitee's copies follow the language the invitee booked in.

- `@slate/notifications`: the host's copy of the request, of the confirmed booking and of the move carries the requester's name, email and phone, any other guests, and every answer to the event type's questions in its order under the host's own labels (a multi-select reads as a list, a checkbox as Yes or No, empty answers are left out; a key no question names is never listed), in both the HTML and the text part, whatever the template says. The host's request gets its one button, "Confirm or decline", to the booking in the host's dashboard (`dashboardUrl`); the link only opens the page behind the host's login, so a mail scanner that follows it changes nothing. The footer's support line is the deployment's own (`EmailGrowth.supportEmail`), and absent when none is configured. New exports: `collectBookingAnswers`, `bookingDetails`, `bookingDetailsText`, `readableAnswer`, `hostDashboardUrl`.
- `@slate/db`: new nullable `booking.locale` (migrations `postgres/0025`, `sqlite/0024`), the language the invitee booked in, written by `createBooking` / `createTeamBooking` from the new `locale` argument (`bookingLocale` keeps `en`/`es`, else NULL) and carried by the v2 reschedule. `loadBookingNotificationContext` also returns `attendeeLocale`, the attendee's `phone` and `notes`, the booking's other `guests`, and the event type's `bookingFields`, and its invitee is now the attendee who booked (the one a v2 caller named, else the first row written) rather than whichever attendee row a bare `LIMIT 1` met first, which on Postgres could be an extra attendee. Extra attendees are written a millisecond after the invitee.
- `@slate/config`: `MAIL_SUPPORT_EMAIL`, unset by default.
- `@slate/types`: `createBookingSchema` takes an optional top-level `locale` (`en` | `es`), the language of the page the visitor booked on; an explicit `attendee.language` wins. The booking page sends it there rather than as `attendee.language`, which feeds the CRM contact property and stays as it was.
- `@slate/shared`: `adminBookingPath(uid)`, the dashboard's link to one booking, shared by the mail and the page it opens.
- Copy the host wrote (an account template, an event reminder's text) keeps the host's language for the whole message, as before: it is written in one language.
