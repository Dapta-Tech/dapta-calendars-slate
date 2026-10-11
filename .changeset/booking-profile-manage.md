---
'@slate/shared': patch
---

The profile and the manage page, in the event page's language.

- **Profile** (a host's and a team's landing): the cover, the avatar on its
  lower edge, the name, the bio, then one framed list of what can be booked,
  a hairline between rows and the duration set as a figure so the durations
  read as a column. With nothing to book it says so in a sentence. The studio's
  profile preview renders the same component, in the host's event order.
- **Manage page**: the event page's sequence, with the booking where the event
  panel goes. Rescheduling is the month and that day's times, then the new
  time restated with one button that moves the booking; cancelling is a quiet
  red outline under the booking (after the month, on a phone). It now wears
  the host's own branding when the booking names the host.
- `@slate/shared` adds `readableZone` ("America/New York") and the profile's
  minutes unit in English and Spanish.
