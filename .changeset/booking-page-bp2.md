---
'@slate/calendar': patch
'@slate/types': patch
'@slate/shared': patch
'@slate/db': patch
---

Carry the connected account's photo, and give a long description a ceiling.

`CalendarSummary` and the discovery record gain an OPTIONAL `avatarUrl`, so a
calendar backend that knows the connected account's photo can report it. It is
stored on `connected_calendar` (additive, nullable, both dialects) and surfaces
as `PublicProfile.member.connectedAvatarUrl` — beside the host's own
`avatarUrl`, never merged into it: that column feeds the studio's input, and a
sync landing there would turn a fallback into a saved value that outlives the
connection. A backend that reports nothing behaves exactly as today.

The booking page's copy gains `bookingPage.descriptionMore` / `descriptionLess`
for the description clamp, and the studio gains
`studio.photoFromConnectedAccount` — a host whose page is drawing the connected
account's photo should be told where that face came from, and that uploading
their own replaces it.

`setConnectionAvatar` takes an `accountId`: it is a new write, and every
repository write is account-scoped.
