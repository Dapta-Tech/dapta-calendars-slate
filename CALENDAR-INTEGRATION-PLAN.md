# Calendar Integration — Plan (feat/calendar-vendor-live)

**Mission:** make the external-calendar lifecycle work provably end-to-end —
connect → list → free-busy subtracts → book writes out → reschedule moves →
cancel deletes → disconnect cleans up → failures retry (outbox) + surface in UI.

**Guiding principle:** the durable spine is already built and proven (outbox
`calendar:create/update/delete`, `booking_reference` DH1 claim, `connected_calendar`,
`loadExternalBusy` seam wired into availability). We **add the live adapter + the
connect UX + true reschedule**; we do **not** rebuild the spine.

---

## What already exists (verified in the study pass — reuse)

| Piece | Location | State |
|---|---|---|
| `CalendarProvider` port (`listBusy`/`createEvent`/`deleteEvent`, `enabled`) | `packages/calendar/src/index.ts` | ✅ port + `Disabled` + `InMemory` fakes |
| Provider seam (`disabled`/`external`, fail-loud) | `apps/api/src/calendar.provider.ts` | ✅ `external` currently throws |
| Write-out effects (enqueue → outbox → `runCalendarJob`, DH1 idempotency) | `apps/api/src/calendar-effects.ts` | ✅ create/delete/reschedule as delete+recreate |
| Outbox worker (retry+backoff, proven PG parity) | `apps/api/src/outbox.worker.ts` | ✅ |
| DB seam (conflict/destination refs, external busy, `booking_reference` claim) | `packages/db/src/calendar-refs.ts` | ✅ |
| Availability subtraction wired | `apps/api/src/booking.service.ts` (`this.calendar.provider` → `loadExternalBusy`) | ✅ no-op on disabled |
| Connections CRUD + one-destination R20 constraint | `packages/db/src/parity.ts`, `apps/api/src/host.controller.ts` (`/v1/connections*`) | ✅ manual add only |
| Connections UI (status banner, connect dialog, rows, test/disconnect) | `apps/web/app/admin/connections/*` | ✅ dialog is a stub (returns status text) |
| Config seam | `packages/config/src/env.ts` `CALENDAR_PROVIDER` | ✅ |

**Gaps to close:** (1) `external` provider throws — no live adapter. (2) connect
flow is a stub (`connectionToken` returns "no provider" text) — no real OAuth. (3)
no `listCalendars` (can't pick calendars post-connect). (4) reschedule = delete +
recreate (new event id) — brief wants the SAME event moved. (5) per-connection
health is hardcoded "not wired".

---

## R15 public / private split (mirrors the AuthProvider seam exactly)

The vendor (integration platform behind the bridge) name / host / key structure
**never** appears in committed code. Pattern parallels `auth.provider.ts` (public
fail-loud seam) + `auth.provider.workos.ts` (committed, inert) + `/deploy/`
(gitignored) + `.env` (gitignored).

### PUBLIC (committed to this branch — vendor-free, generic HTTP contract)
- `packages/calendar/src/index.ts` — port additions: `listCalendars`,
  `updateEvent` (true reschedule), and health surfaced via existing calls.
- `apps/api/src/calendar.provider.external.ts` — **`ExternalCalendarProvider`**:
  a generic REST client. Reads a base URL from env, gets a bearer token from a
  pluggable **`CalendarTokenSource`**, and speaks a normalized contract we define
  (`free-busy`, `events` CRUD, `calendars`, `connect-token`). No vendor name, no
  host, no key shape. Committed but **inert** until `CALENDAR_PROVIDER=external`.
- `apps/api/src/calendar.provider.ts` — `external` case builds the adapter when
  base URL + token source resolve; **fails loud** otherwise (never silent-disable).
- `CalendarTokenSource` seam: interface + env-static default
  (`CALENDAR_API_TOKEN`), plus a dynamic loader for the private authority.
- `packages/config/src/env.ts` — generic keys only: `CALENDAR_API_BASE_URL`,
  `CALENDAR_API_TOKEN?` (issuer/host/secret left to `.env`, never hardcoded — same
  rule as `JWT_ISSUER`/`JWT_AUDIENCE`).
- Connect UX in `apps/web/app/admin/connections/*`: popup-blocker-safe flow.
  **R15-critical:** the legacy FE imported the vendor SDK (`@membranehq/sdk`)
  directly — that package/import must NEVER appear in the public repo. Instead
  `POST /connections/token` returns a generic `{ token, connectUrl }`; the FE
  pre-computes it on dialog-open and `window.open(connectUrl)` in the click
  handler (no SDK import). Connection completion is detected server-side (redirect
  callback → `POST /connections`, or list-and-diff with an admin token) — decided
  in step 2 against what the vendor connect flow supports. End-provider names
  (Google/Outlook) are allowed in UI; the integration platform name is not.

### PRIVATE (gitignored — `/deploy/` overlay + local `.env`, from AWS SM read-only)
- `deploy/calendar/token-authority.ts` — mints the vendor JWT (HS512:
  workspaceKey / tenantKey / isAdmin scope) from `CALENDAR_SIGNING_SECRET`; sets
  the real base URL; maps end-provider → integrationKey. Loaded dynamically by
  the token-source seam if present.
- local `.env` (gitignored): `CALENDAR_PROVIDER=external`,
  `CALENDAR_API_BASE_URL=<vendor host>`, `CALENDAR_SIGNING_SECRET=<AWS SM>`,
  `CALENDAR_WORKSPACE_KEY=<...>`. Reconstructed READ-ONLY from AWS SM `dapta-dev`
  (env-reconstruction pattern). **Never printed, never committed.**

*Fallback if the generic contract can't fully absorb a vendor idiosyncrasy:*
push the offending path/action-key into an env template string (e.g.
`CALENDAR_FREEBUSY_PATH`) so the committed adapter stays vendor-agnostic — decide
per-endpoint during step 3/4, flag to PM before deviating further.

---

## Build order (report to PM after each step)

1. **Study + this plan** — ✅ done.
2. **Token authority + connect flow.** Port `listCalendars`; `ExternalCalendarProvider`
   + `CalendarTokenSource` + private authority; make `connectionToken` return a
   real `{ token, connectUrl }`; wire the popup-blocker-safe connect UX + post-connect
   calendar pick. Per-connection `ping` calls the live health check.
3. **Free-busy live.** `ExternalCalendarProvider.listBusy` hits the real free-busy
   endpoint; confirm `loadExternalBusy` → availability subtraction with a real busy block.
4. **Write-out create/update/delete.** `createEvent`/`deleteEvent` live; add
   `updateEvent` and switch `runCalendarJob('reschedule')` to move-in-place
   (keep DH1). Failures throw → outbox retries (already proven).
5. **Live 8-step proof + report.** Real calendar, dev creds: connect, list,
   free-busy subtract, book (event appears), reschedule (same event moves),
   cancel (event gone), disconnect (stops subtracting), induced 4xx → outbox
   retry + UI health. Evidence: API responses + calendar screenshots. Unit +
   integration tests per step.

## Guardrails
- Lane: `packages/calendar`, connections API surface, `/admin/connections`(+`/settings/calendars`) FE only. No auth/booking-engine/other-admin edits.
- Migrations additive-only, both dialects, SAFE. English. Small conventional commits. Tests per step.
- Any UI passes DESIGN-QUALITY-BAR + list/create pattern + `dit_sidecar_fe_reviewer` gate.
- Secrets read-only from AWS SM; never printed/committed.
