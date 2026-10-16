---
'@slate/db': minor
'@slate/notifications': minor
'@slate/config': minor
---

The host's copy of a booking email says who is asking and what they answered, and the invitee's copies follow the language the invitee booked in.

- `@slate/notifications`: the host's copy of the request, of the confirmed booking and of the move carries the requester's name, email and phone, any other guests, and every booking-form answer in the event type's question order under the host's own labels (a multi-select reads as a list, a checkbox as Yes or No, empty answers are left out), in both the HTML and the text part, whatever the template says. The host's request gets its one button, "Confirm or decline", to the booking in the host's dashboard (`dashboardUrl`); the link only opens the page behind the host's login, so a mail scanner that follows it changes nothing. The footer's support line is the deployment's own (`EmailGrowth.supportEmail`), and absent when none is configured. New exports: `collectBookingAnswers`, `bookingDetails`, `bookingDetailsText`, `readableAnswer`, `hostDashboardUrl`.
- `@slate/db`: new nullable `booking.locale` (migrations `postgres/0025`, `sqlite/0024`), the language the invitee booked in, written by `createBooking` / `createTeamBooking` from the new `locale` argument (`bookingLocale` keeps `en`/`es`, else NULL) and carried by the v2 reschedule. `loadBookingNotificationContext` also returns `attendeeLocale`, the attendee's `phone` and `notes`, the booking's other `guests`, and the event type's `bookingFields`.
- `@slate/config`: `MAIL_SUPPORT_EMAIL`, unset by default.
