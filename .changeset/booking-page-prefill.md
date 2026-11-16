---
"@slate/types": minor
---

Let a booking page start its form filled from its own address, so a visitor sent
here by a page that already asked for their name and email does not type either
one again on the way to a slot. `normalizeBookingPrefill` reads `name`, `email`
and `notes` plus one value per custom booking field under `answer_<fieldName>`,
trimmed and capped, dropping anything carrying a control or invisible format
character exactly as a campaign value is dropped. Custom fields are prefixed
rather than named bare so one can never collide with a parameter the page
already owns (`embed`, `lang`, `theme`, `brand_color`, the embed style axes, the
`utm_*`), and are keyed by field NAME rather than by position, so reordering a
host's questions cannot silently aim a value at the wrong one.
