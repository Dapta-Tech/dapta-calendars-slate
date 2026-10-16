# Booking page redesign: screenshots

Evidence for the booking-page redesign PRs. Not code; never merged.

- `pr-a/before-matrix/`: the public surface as the renderer drew it before the redesign (event page per template, canvas and slot layout; profile; details step; confirmation; manage; embed) at 360, 820 and 1440.
- `pr-a/public-same/`: the same fixture rendered by the base and the branch in the same minute.
- `pr-a/admin/`: admin screens before and after the palette change.
- `profile-center/`: the profile head on the column's axis and the account line said once. `before/` is `develop` at `ea1f4bc`, `after/` the branch `fix/profile-header-centered`; person profile (account named like the host; company account with cover, photo and bio) and team landing, dark and light, at 360, 1440 and 2000, with `measures.json` (horizontal centres of the column, avatar, name, list, CTA and badge). `*-extra/` adds the monogram over a cover, the kit logo with and without a cover, the empty profile, the inline embed and the studio preview. `compare/` puts each pair side by side.
- `booking-emails/`: the host's request email says who is asking and what they answered, with one "Confirm or decline" button to the booking in the dashboard. Rendered by `@slate/notifications` from an invented fixture (host in America/Bogota, visitor in America/Phoenix, phone, two other guests, four answers and notes). `before/` is `develop` at `0f49d2d`, `after/` the branch `fix/booking-emails-host-details` (also the host's confirmed and moved copies); `compare/` puts the request side by side, EN and ES; `text/` holds the plain-text part of each. The before footer names the support address that was hard-coded then; after, the line follows `MAIL_SUPPORT_EMAIL` and is absent when unset, as here.
