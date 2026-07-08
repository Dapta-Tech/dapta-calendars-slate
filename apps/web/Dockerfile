# Deployment-agnostic web image (Node runtime, no host-only APIs).
# Build context = repository root:  docker build -f apps/web/Dockerfile -t slate-web .
FROM node:20-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

FROM base AS build
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build:packages
RUN pnpm --filter @slate/web build

FROM base AS run
WORKDIR /app
ENV NODE_ENV=production
# Next standalone bundles the server + its minimal node_modules.
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public
EXPOSE 3000
ENV PORT=3000
CMD ["node", "apps/web/server.js"]
