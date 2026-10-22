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
# The same digest-pinned Node 22 image as apps/api/Dockerfile's base: bump both
# together, and .nvmrc with them (CI reads it).
FROM node:22-trixie-slim@sha256:8eb619e402eaede1748a3c8173bffab391592812e85136452f781741c7242ddf AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

# ---- build: install, build packages, build Next (standalone) -----------------
FROM base AS build
WORKDIR /repo
# Baked into the client bundle — pass per environment at build time.
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
# Brand + growth-loop link — also NEXT_PUBLIC (inlined at build). Vendor-neutral
# defaults keep the OSS build generic; Dapta's CI passes "Dapta Calendars" + the
# platform URL. (Deploy-enabling change per ECR-CI-PLAN §3.)
ARG NEXT_PUBLIC_PRODUCT_NAME=Calendars
ENV NEXT_PUBLIC_PRODUCT_NAME=$NEXT_PUBLIC_PRODUCT_NAME
ARG NEXT_PUBLIC_PLATFORM_URL=
ENV NEXT_PUBLIC_PLATFORM_URL=$NEXT_PUBLIC_PLATFORM_URL
# Where the Forms sidecar lives. Set = the app switcher links to it; unset = "Coming soon".
ARG NEXT_PUBLIC_FORMS_URL=
ENV NEXT_PUBLIC_FORMS_URL=$NEXT_PUBLIC_FORMS_URL
# Where "Create your free calendar" and the "Made with" badge send a visitor. Unset = neither renders (a fork shows no Dapta growth surface).
ARG NEXT_PUBLIC_SIGNUP_URL=
ENV NEXT_PUBLIC_SIGNUP_URL=$NEXT_PUBLIC_SIGNUP_URL
COPY . .
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile
RUN pnpm build:packages
RUN pnpm --filter @slate/web build

# ---- run: standalone server, non-root ----------------------------------------
FROM base AS run
ENV NODE_ENV=production
# Server components read NEXT_PUBLIC_* from the RUNTIME env (inlining only
# covers client bundles) — re-declare in the run stage so SSR'd metadata (tab
# title, switcher) carries the brand too. Same values CI passes to build.
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_PRODUCT_NAME=Calendars
ENV NEXT_PUBLIC_PRODUCT_NAME=$NEXT_PUBLIC_PRODUCT_NAME
ARG NEXT_PUBLIC_PLATFORM_URL=
ENV NEXT_PUBLIC_PLATFORM_URL=$NEXT_PUBLIC_PLATFORM_URL
# Where the Forms sidecar lives. Set = the app switcher links to it; unset = "Coming soon".
ARG NEXT_PUBLIC_FORMS_URL=
ENV NEXT_PUBLIC_FORMS_URL=$NEXT_PUBLIC_FORMS_URL
# Where "Create your free calendar" and the "Made with" badge send a visitor. Unset = neither renders (a fork shows no Dapta growth surface).
ARG NEXT_PUBLIC_SIGNUP_URL=
ENV NEXT_PUBLIC_SIGNUP_URL=$NEXT_PUBLIC_SIGNUP_URL
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
