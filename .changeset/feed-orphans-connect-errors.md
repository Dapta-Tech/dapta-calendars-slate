---
"@slate/api": patch
"@slate/web": patch
---

Two follow-ups from the release review.

- MCP `list_bookings` / `list_pending_bookings` keep a booking whose event type
  was deleted (it lists with an empty event title). Before, such bookings were
  left out, so a later cancellation of one never reached the `updated_since`
  feed.
- The Calendars connect dialog answers only the API's 503 ("the connect could
  not start") with its "try again" text. Any other failure (a 500, the API
  unreachable) is thrown as before, so it reaches the error page and error
  tracking instead of passing as a busy provider.
