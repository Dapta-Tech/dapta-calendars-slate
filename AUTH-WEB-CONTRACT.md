# Auth — Web ↔ API Contract (for the `apps/web` agent)

**Owner of this doc:** auth-lane agent (API side). **Implements FROM this doc:** the `apps/web` agent.
**Status:** API side is DONE and merged on `feat/workos-auth-overlay`. `apps/web` has **no** auth yet
(no `/login`, no logout, no session, no identity headers) — this contract specifies exactly what to build.

> **One rule:** the API is the source of truth for *identity resolution*; the web is the source of truth for
> *session lifecycle* (obtain a credential, store it, send it, clear it). The web authenticates to the API
> the SAME way in every environment — it only differs in **how it obtains** the credential (dev email form vs
> WorkOS redirect). Everything below is stable regardless of provider unless a section says otherwise.

---

## 0. The seam (what the API already does)

Host/dashboard requests hit `/v1/*` and the API resolves identity via `AuthService.resolveHost(req)`, backed by
an `AuthProvider` chosen by the **`AUTH_PROVIDER`** env (`local` | `workos`). The web does not choose the
provider — the deployment does. The web must satisfy **both** providers' input contract (§2, §3) so the same
build works in dev and prod.

**Failure shape (identical for both providers):** on no/invalid identity the API responds

```
HTTP 401
{ "error": "UNAUTHENTICATED", "message": "..." }
```

**The web MUST treat any `401` from `/v1/*` as "logged out" → run the logout/redirect flow (§4).** This is the
missing piece today: nothing in `apps/web` reacts to a 401, so logout appears to do nothing.

**Identity probe:** `GET /v1/me` → `200` with
`{ accountId, accountCode, memberId, handle, displayName, email, timeZone, locale }` when authenticated, `401`
when not. Use it as the server-side "am I logged in?" check when rendering `/admin`.

---

## 1. How the web sends the credential to the API (both providers)

All API calls from the web go through `apps/web/lib/admin-api.ts` (the `req()` helper). Today it sends **no
identity**. It MUST attach identity on every host call:

| Provider | Header the web MUST send |
|---|---|
| `workos` | `Authorization: Bearer <platform-JWT>` |
| `local`  | `x-slate-email: <email>` (dev login) — or `x-slate-account` + `x-slate-member` for explicit impersonation |

Implementation: `admin-api.ts` reads the current session (see §2/§3 for where it's stored) and sets the right
header. It is fine to always set `Authorization` when a JWT session exists and always set `x-slate-email` when a
dev-email session exists — the API uses whichever its configured provider reads and ignores the other.

---

## 2. `AUTH_PROVIDER=local` — dev email login (zero external dependency)

Purpose: a developer logs in as themselves with **no WorkOS account**. The API's local stub resolves the member
by email and JIT-creates an isolated account+member if it's a new email.

**Login (web builds this):**
1. `/login` route renders an email form (dev only). On submit, the web establishes a session that carries the
   email — store the email in an **httpOnly session cookie** (recommended `slate_session`).
2. `admin-api.ts` sends that email as **`x-slate-email: <email>`** on every `/v1/*` call.
3. Redirect to `/admin`.

**Logout (web builds this):** clear the `slate_session` cookie → redirect to `/login`. No server round-trip
needed for `local`.

**Strict mode = the fix for "logout does nothing" in local.** The API now supports
**`AUTH_LOCAL_STRICT=true`** (default `false`):
- **`false` (default, OSS clone-and-run):** a request with no identity falls back to the first seeded account —
  i.e. "always logged in", zero friction. Logout has nothing to bounce to (expected for a bare fork).
- **`true` (recommended for Dapta dev):** a request with no identity → **401**. This creates a real
  "logged out" state. So: web clears the cookie → next `/v1/me` is `401` → web redirects to `/login`. **This is
  what makes local logout behave like the old Angular app.** Set `AUTH_LOCAL_STRICT=true` in the dev env when
  you want that behavior; leave it unset for the frictionless default.

There is also a no-cookie shortcut for a single-user machine: setting **`DEV_LOGIN_EMAIL`** on the API makes
every otherwise-unidentified request resolve to that email. Useful for quick starts; the cookie form above is
what supports real login/logout.

---

## 3. `AUTH_PROVIDER=workos` — real login via the IAM-fronted WorkOS AuthKit

**Key architecture fact:** the web does **NOT** talk to WorkOS directly and holds **NO** WorkOS secret. Login is
fronted by the existing identity service **`dapta-iam-ms`** (the same one `app.dapta.ai` uses). IAM wraps WorkOS
AuthKit and, after login, mints the **platform JWT** the Slate API validates (HS256, `iss=dapta-iam-ms`,
`aud=dapta-platform`, access token TTL **10 days**, refresh token TTL **30 days**).

### 3.1 Login redirect (web builds this)
1. Web calls IAM: **`GET {IAM_BASE_URL}/auth/login-url?returnTo=<web-callback-URL>`**
   (optional `&loginHint=<email>`, `&screenHint=sign-up`). → `200 { loginUrl }`.
2. Web redirects the browser to `loginUrl` (WorkOS AuthKit hosted page — Google/Microsoft/LinkedIn buttons are
   rendered by WorkOS; **nothing to build per-provider**).
3. User authenticates at WorkOS → WorkOS calls IAM **`GET {IAM_BASE_URL}/auth/callback`** → IAM completes the
   handshake, mints the platform tokens, and returns to the web's `returnTo`.

### 3.2 Callback + token receipt (web builds this)
The web exposes a server route (recommended `GET /api/auth/callback` = the `returnTo` it passed) that receives
the platform **access token (JWT)** + **refresh token** from IAM and stores them in an **httpOnly, Secure,
SameSite=Lax** cookie (recommended `slate_session`). Do NOT expose the JWT to client-side JS.

> **⚠️ CONFIRM ONE DETAIL against `dapta-iam-ms` before wiring:** the exact way `/auth/callback` returns the
> tokens to `returnTo` — query param vs `Set-Cookie` vs a follow-up `POST /auth/verify-code`/session-exchange
> call. See `dapta-iam-ms/src/auth/workos/workos-auth.controller.ts` (`@Get('callback')`, ~L405) and the
> `create-unified-session` usecase. This is the single integration point not fully specified here; everything
> else is fixed. (Magic-code and password paths also exist: `POST /auth/send-code` + `POST /auth/verify-code`,
> `POST /auth/login-password` — same token result.)

### 3.3 Sending the credential
`admin-api.ts` reads the access token from the `slate_session` cookie and sends
**`Authorization: Bearer <access-token>`** on every `/v1/*` call. (The API validates signature + `iss`/`aud` +
`exp`; it never calls WorkOS/IAM.)

### 3.4 Refresh / expiry
- Access token TTL = **10d**, refresh token TTL = **30d**.
- On a `401` from `/v1/*`, the web SHOULD attempt a refresh via **IAM's refresh endpoint** (confirm the exact
  route/DTO in `dapta-iam-ms` refresh-token usecase) using the stored refresh token; on success, replace the
  cookie's access token and retry once; on failure, treat as logged out (§4).

### 3.5 Logout (web builds this) — the WorkOS logout redirect
1. Web clears the `slate_session` cookie.
2. Web redirects the browser to **IAM's logout** (which performs the **WorkOS session logout redirect** and
   returns to a `return_to` you supply — confirm the exact IAM logout route; the IAM `LogoutCommand`/`logout`
   usecase exists). This is what fully ends the WorkOS session, matching the old app. A cookie-only clear leaves
   the WorkOS session alive and the next login silently re-auths — so the IAM/WorkOS logout redirect is
   required for a true logout.

---

## 4. Unified web logout / gate behavior (applies to both providers)

- **Gate `/admin`:** server-side, call `GET /v1/me`; `401` → redirect to `/login` (local) or the IAM login URL
  (workos). Never render the dashboard for an unauthenticated request.
- **On any `/v1/*` `401`:** clear the session cookie, then: `local` → `/login`; `workos` → refresh once (§3.4),
  else IAM/WorkOS logout redirect (§3.5).
- **Public booking pages (`/<accountCode>/<handle>` etc.) stay unauthenticated** — never gate them.

---

## 5. Env vars the web needs (NAMES ONLY — never commit values)

**Web app env (`apps/web`):**

| Var | Purpose | Notes |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | Base URL of the Slate API | already used by `admin-api.ts` |
| `AUTH_PROVIDER` | Mirror of the API's provider so the web picks the right login UX | `local` \| `workos` |
| `IAM_BASE_URL` | `dapta-iam-ms` base URL (server-side; workos only) | dev/staging value known internally as the IAM service host |
| `WEB_SESSION_SECRET` | Secret to sign/encrypt the `slate_session` httpOnly cookie | server-only; never `NEXT_PUBLIC_*` |
| `AUTH_LOCAL_STRICT` | Optional mirror for local-mode UX (show login vs auto-in) | matches the API flag |

**API env (already defined by the auth lane — for reference, the web does not set these):**
`AUTH_PROVIDER`, `JWT_SECRET`, `JWT_ISSUER`, `JWT_AUDIENCE`, `DEV_LOGIN_EMAIL`, `AUTH_LOCAL_STRICT`.

**AWS Secrets Manager locations (names only — values live only in SM / the private overlay):**

| Secret key path | Properties (names only) | Consumer |
|---|---|---|
| `dapta-{dev,prd}/general/slate-api` | `JWT_SECRET`, `JWT_ISSUER`, `JWT_AUDIENCE` | Slate API (`workos` validation) |
| `dapta-{dev,prd}/general/slate-web` | `WEB_SESSION_SECRET` | Slate web (session cookie) |
| `dapta-{dev,prd}/general/dapta-iam-ms` | `JWT_SECRET` (**the SAME signing secret** the API validates against) | IAM (issuer) — **read-only reference; the web/API never write it** |

> The Slate API's `JWT_SECRET` MUST equal IAM's signing secret (that is how the API validates IAM-minted
> tokens). It is copied read-only into `slate-api`'s SM key — **ADD-ONLY, never rotate/rename IAM's key.**
> The IAM base URL + WorkOS AuthKit domain are configmap/config, not secrets. Staging AuthKit domain is
> `striking-track-77-staging.authkit.app` (prod `striking-track-77.authkit.app`) — the web never needs it
> directly because IAM builds the login URL.

---

## 6. Acceptance checklist (Definition of Done for the web agent)

- [ ] `admin-api.ts` attaches `Authorization: Bearer` (workos) / `x-slate-email` (local) on every `/v1/*` call.
- [ ] `/admin` is gated by `GET /v1/me`; `401` → login.
- [ ] `local`: `/login` email form → `slate_session` cookie → lands in the developer's OWN account.
- [ ] `local` + `AUTH_LOCAL_STRICT=true`: logout clears the cookie and the next request bounces to `/login`.
- [ ] `workos`: login redirects via `GET {IAM}/auth/login-url` → WorkOS → callback stores tokens.
- [ ] `workos`: a `401` triggers one refresh attempt, then logout.
- [ ] `workos`: logout clears the cookie AND redirects through the IAM/WorkOS logout (true session end).
- [ ] Public booking pages remain unauthenticated.
- [ ] No secret/JWT is ever exposed to client-side JS or committed.

## 7. What is FIXED here vs what the web agent must CONFIRM

- **Fixed (do not re-derive):** the API 401 shape, the header contract (§1), `/v1/me` shape, provider input
  contracts, token TTLs (10d/30d), `iss`/`aud`, the env/SM names, and the strict-mode logout behavior (built +
  tested on the API).
- **Confirm against `dapta-iam-ms` before wiring workos:** (a) the `/auth/callback` token-delivery mechanism
  (§3.2), (b) the exact refresh route/DTO (§3.4), (c) the exact logout route + `return_to` param (§3.5). These
  are IAM's HTTP surface, not Slate's — read `src/auth/workos/workos-auth.controller.ts` +
  `src/auth/session/**` in `dapta-iam-ms`.
