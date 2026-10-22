---
"@slate/db": patch
"@slate/shared": patch
---

`listTeamMembers` (`GET /v1/teams/:id/members`) adds two booleans, additive and account-scoped: `has_hours` (the member's default schedule has at least one availability rule; an invited member has none until their first sign-in) and `has_calendar` (any connected calendar). New EN and ES copy under `admin.eventTypes.teamHosts` for who is not ready to host. In Spanish the invited state reads "Invitación pendiente" in Members and in the workspace switcher alike (it read "Invitado" in one and "Pendiente" in the other; "invitado" is also a booking's guest).
