# Slate API — deployment-agnostic production image (Node runtime).
#
# Build context = repository ROOT:
#   docker build -f apps/api/Dockerfile -t slate-api .
#
# Small, pnpm-workspace-aware, non-root. Uses `pnpm deploy` to emit a pruned,
# production-only bundle (only @slate/api + its runtime workspace deps — no dev
# deps, no other apps, no unrelated package source) instead of shipping the
# whole monorepo in the runtime layer.
#
# Deployment-agnostic: the same artifact runs on EKS, a bare Node host, or
# docker-compose. Point DATABASE_URL at managed Postgres in prod; leave it
# unset for SQLite. Database MIGRATIONS are NOT run here — they are a separate,
# gated release step (see deploy/DEPLOY-INTERNAL.md § migration-safety), so
# scaling to N replicas never races N migrators.

# ---- base: pnpm via corepack -------------------------------------------------
FROM node:20-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

# ---- build: install, build packages, emit a pruned production bundle ---------
FROM base AS build
WORKDIR /repo
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile
# Build the workspace packages the API imports (@slate/engine, @slate/db, …) to
# their dist/ outputs, then produce a self-contained production bundle.
RUN pnpm build:packages
# --legacy: pnpm v10 refuses `deploy` without inject-workspace-packages; we build
# workspace deps to dist/ ourselves, so the legacy copy-based deploy is correct.
RUN pnpm --filter @slate/api deploy --legacy --prod /prod/api

# ---- run: minimal runtime, only the pruned bundle, non-root ------------------
FROM base AS run
ENV NODE_ENV=production
# Non-root (mirrors calendar-ms: runAsNonRoot / uid 1001). node:20-slim ships a
# `node` user; use it and own the app dir.
WORKDIR /app
COPY --from=build --chown=node:node /prod/api ./
USER node
EXPOSE 4000
ENV API_PORT=4000
# Start the API only. tsx is a runtime dependency of @slate/api; the bundle
# carries the compiled workspace deps under node_modules. Invoke tsx directly —
# `pnpm start` would make corepack fetch the LATEST pnpm at container start,
# which requires Node 22+ (the pruned bundle carries no packageManager pin) and
# crash-loops on node:20. No package manager belongs in the runtime path.
# --tsconfig tsconfig.runtime.json: the dev tsconfig's extends chain
# (@slate/config) doesn't resolve inside the pruned bundle and tsx would drop
# the whole config (losing experimentalDecorators → Nest crash at boot).
CMD ["node_modules/.bin/tsx", "--tsconfig", "tsconfig.runtime.json", "src/main.ts"]
