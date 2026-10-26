---
"@slate/db": patch
---

Every count and dedupe of the people on a booking reads one normalized address
per person: `normalizedEmailSql` (now exported for the package's own reads) in
SQL and `normalizeAttendeeEmail` in code.
- v2 guests (`addGuestsToBooking`) take the machine attendee's cap: at most
  `BOOKING_PEOPLE_LIMIT` (30) people in all, or the event's seats when those
  are more, each person counted once across attendee rows, guest rows and the
  guests a v2 booking names in its metadata. Before, the cap was 30 guests by
  rows: it left the attendees out and counted a guest listed in two places
  twice. An address already on a full booking is not refused (nothing to add).
- A guest's `email_normalized` is written with `normalizeAttendeeEmail`.
- A group slot's seats count each person once: the availability read, the
  hold check and the seat write all count distinct normalized addresses, and
  the seat write's dedupe normalizes what it reads again in code.
- The host's notification lists and the v2 move's attendee copy use the same
  normalizer (no change in what they produce).
