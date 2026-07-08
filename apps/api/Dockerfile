# Deployment-agnostic API image (Node runtime).
# Build context = repository root:  docker build -f apps/api/Dockerfile -t slate-api .
FROM node:20-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

FROM base AS build
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build:packages

FROM base AS run
WORKDIR /repo
ENV NODE_ENV=production
COPY --from=build /repo ./
EXPOSE 4000
ENV API_PORT=4000
# Run migrations, then start the API. Point DATABASE_URL at Postgres in prod.
CMD ["sh", "-c", "pnpm db:migrate && pnpm --filter @slate/api start"]
