---
"@slate/db": patch
---

Adding people to an existing booking (a seat on a group slot, v2 guests, the
machine API's add-attendee) now bumps the booking's `updated_at`, like every
other lifecycle write. A reader that lists bookings changed since an instant
sees the booking that gained someone.
