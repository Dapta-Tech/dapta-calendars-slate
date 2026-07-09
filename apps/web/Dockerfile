# Slate web — deployment-agnostic production image (Next standalone, Node runtime).
#
# Build context = repository ROOT:
#   docker build -f apps/web/Dockerfile -t slate-web .
#
# Uses Next's `output: 'standalone'` (already set in next.config.mjs), which
# traces the monorepo and bundles the server + only the node_modules it needs —
# a naturally small image. Node runtime, no Vercel-only APIs: the same artifact
# self-hosts on EKS / any Node host AND stays one-click Vercel-deployable.
#
# NOTE — NEXT_PUBLIC_API_URL is INLINED AT BUILD TIME by Next (it reaches client
# components). So it is a build ARG, not a runtime env: dev and prd build
# separate images with their own API URL. Server-only code still reads it from
# the runtime env. (Future: a same-origin `/api` proxy would make one image
# env-portable — an app change, tracked in DEPLOY-INTERNAL.)

# ---- base: pnpm via corepack -------------------------------------------------
FROM node:20-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

# ---- build: install, build packages, build Next (standalone) -----------------
FROM base AS build
WORKDIR /repo
# Baked into the client bundle — pass per environment at build time.
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile
RUN pnpm build:packages
RUN pnpm --filter @slate/web build

# ---- run: standalone server, non-root ----------------------------------------
FROM base AS run
ENV NODE_ENV=production
WORKDIR /app
# Next standalone bundles the server + its minimal node_modules.
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
CMD ["node", "apps/web/server.js"]
