# WorkOS Integration — Status Report

**Branch:** `feat/workos-auth-overlay` · **Date:** 2026-07-10 · **HEAD:** `9354db6` (same as `main`)

---

## 1) WHAT IS DONE (implemented + tested at unit/integration level)

- **API adapter** — `WorkOsAuthProvider` (`apps/api/src/auth.provider.workos.ts`): validates the upstream
  IAM-issued **HS256 JWT** (same contract the old `dapta-calendar-ms` validated), maps `account_id`/`sub`
  → `{accountId, memberId}` with JIT-provisioning. ✅
- **JWT verifier** — `apps/api/src/jwt.ts`: dependency-free, defensive (alg hard-pinned to HS256, rejects
  `none`/RS/ES; constant-time signature compare; `exp` required; `iss`/`aud` enforced only when set). ✅
- **Factory wiring** — `apps/api/src/auth.provider.ts`: `AUTH_PROVIDER=workos` returns the adapter when
  `JWT_SECRET` is set, and **fails loud** otherwise (never silent fallback to the insecure local stub). ✅
- **Env wiring** — `packages/config/src/env.ts`: `JWT_SECRET` / `JWT_ISSUER` / `JWT_AUDIENCE`, all optional,
  backward-compatible (a bare fork still boots on `local`). ✅
- **DB** — additive nullable `external_id` on `account` + `member` (+ unique indexes); SAFE migrations for
  **both** dialects (`sqlite/0003_*`, `postgres/0004_*`). ✅
- **Dev token-minter** — `apps/api/src/cli/mint-token.ts` + `auth:mint` script (offline testing; refuses
  under `NODE_ENV=production`). ✅

**NOT done:**
- **Web login/callback (`apps/web`) — NOTHING.** I do not own `apps/web` (another agent does). The browser
  login redirect, the WorkOS/AuthKit callback, and forwarding the token to the API as
  `Authorization: Bearer` are **not implemented**.
- **Session handling** on the API is **stateless** (validate-per-request; no cookie/session store) — by
  design. But the web side that obtains and sends the token does not exist yet.

---

## 2) COMMITTED vs UNCOMMITTED

- **Committed: ZERO.** `feat/workos-auth-overlay` has **0 commits vs `main`** (HEAD = `9354db6` = main).
  I deliberately did not commit — awaiting Felipe's go.
- **Everything is uncommitted** in the worktree. All files present, none lost:
  - **Modified (6):** `.env.example`, `apps/api/package.json`, `apps/api/src/auth.provider.ts`,
    `packages/config/src/env.ts`, `packages/db/src/schema.pg.ts`, `packages/db/src/schema.sqlite.ts`
  - **New / untracked (7):** `apps/api/src/auth.provider.workos.ts`, `apps/api/src/jwt.ts`,
    `apps/api/src/auth.provider.workos.spec.ts`, `apps/api/src/jwt.spec.ts`,
    `apps/api/src/cli/mint-token.ts`, `packages/db/migrations/sqlite/0003_auth_external_id.sql`,
    `packages/db/migrations/postgres/0004_auth_external_id.sql`

---

## 3) PUBLIC / PRIVATE SPLIT

- **Currently everything lives in the PUBLIC tree** (`apps/api`, `packages/*`) — because the OSS-strip was
  explicitly **deferred by Felipe** (internal-first phase). The adapter sits behind the fail-loud `workos`
  seam.
- **Vendor-neutral by design:** no secret, host, or the strings `dapta-iam-ms` / `dapta-platform` are
  hardcoded — they all arrive via env. So the public source is **R15-clean today** even though the code is
  in-repo.
- **Private overlay** = the `slate-deploy` worktree (branch `chore/deploy-overlay`, `/deploy/` is gitignored).
  It holds flux2 manifests only. **I have not touched it.** Before the public flip, the adapter is extracted
  there and the public factory keeps failing loud.

---

## 4) WHAT REMAINS (concrete + effort)

- **a. Web login/callback in `apps/web`** — redirect to WorkOS, handle callback, obtain the IAM JWT, send it
  as `Authorization: Bearer` to the API. **Owned by the web agent. ~1–2 days.** *Critical path to a real
  login.*
- **b. Commit + open PR** on this branch — **~15 min.**
- **c. AWS SM secrets (names only, ADD-ONLY)** into `dapta-dev/general/slate-api` (and `dapta-prd/general/slate-api`):
  - `JWT_SECRET` — **required** (the shared signing secret; read-only copy of what IAM already uses).
  - `JWT_ISSUER` — optional (else set in configmap; value `dapta-iam-ms`).
  - `JWT_AUDIENCE` — optional (else set in configmap; value `dapta-platform`).
  - Write-to-SM needs Felipe's OK. **~30 min once approved.**
- **d. flux2 overlay delta** — add those keys to `deploy/flux2/{dev,prd}/general/slate-api/externalsecret.yaml`
  + `configmap.yaml`; PR **both hops**, wait for Felipe's clicks; coordinate window with Fausto.
  **~1 hr + review latency.**
- **e. WorkOS dashboard config** — **none required by Slate itself.** Login is served by the existing WorkOS
  tenant via `dapta-iam-ms`. Only possible item (depends on how web login in (a) is wired): register a
  **redirect URI** for the Slate host (`calendar.dapta.dev` / `calendar.dapta.ai`). **~30 min in dashboard if
  needed.** (See open questions in §5.)
- **f. PG parity for the migration** — runs in CI (skipped locally, no Postgres). **~0 (automated).**

---

## 5) DECISIONS WAITING ON FELIPE

- **i.** `sub` → member mapping: currently **JIT-provision + `external_id`**. OK, or map by email?
- **ii.** Which **WorkOS env/tenant** Slate uses — reuse `striking-track-77(-staging)` vs a dedicated one.
- **iii.** Web↔API transport: **Bearer JWT** (my design) vs sealed AuthKit cookie — this is a contract with
  the web agent; needs an owner assigned.
- **iv.** Go-ahead to **commit / open the PR** (§4b).
- **v.** Approval to **seed the SM secret** (`JWT_SECRET`) and open the flux2 PRs (deploy phase, §4c/d).

---

## 6) TESTED END-TO-END?

- **No real login round-trip yet — BLOCKED by:** (a) `apps/web` login/callback does not exist (§4a), and
  (b) no `JWT_SECRET` seeded / no staging-IAM token wired locally.
- **What IS proven (green):**
  - **API: 36 tests pass** — 13 JWT edge cases (tampering, `alg=none`, non-HS256, expiry, nbf, iss/aud,
    malformed); 9 provider (JIT-provision, idempotency, shared-account/distinct-members, and
    wrong-secret / wrong-issuer / wrong-audience / missing-claims → 401).
  - **DB: 38 tests pass** (PG suite skipped locally → covered by CI parity job).
  - **Typecheck clean** (config, db, api).
  - **Minter smoke-tested** — emits a valid token; refuses under `NODE_ENV=production`.
  - Provider exercised **end-to-end in-memory** (migrate → seed → validate token → resolve/JIT principal),
    but **not** through a browser against real WorkOS.
- **To unblock a real round-trip:** assign the web login work (§4a) + seed a dev `JWT_SECRET` and point at
  staging IAM (or use `auth:mint`). I can then drive a full `login → token → API /v1/me` test.

---

*No new work started — this is a report only. Standing by for go on commit/PR and the decisions in §5.*
