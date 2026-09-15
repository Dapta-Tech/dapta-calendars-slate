import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // @slate/* ship plain compiled ES2022 JS, so Next consumes them as normal ESM
  // — no transpilePackages (re-transpiling them injects unresolvable @swc/helpers
  // under pnpm's isolated layout).
  // Node runtime only — deployment-agnostic (self-host on any Node/Docker host
  // AND one-click Vercel). No Vercel-only APIs.
  output: 'standalone',
  experimental: {
    /**
     * The studio saves the booking page through a Server Action, and an avatar
     * or cover is an inline `data:` URL in that payload (there is no file
     * storage). Next's default here is 1MB, which a ~750KB photo already
     * exceeded once base64 added its third — the action threw
     * "Body exceeded 1 MB limit" BEFORE any of our code ran, and the studio's
     * error boundary reported it to the host as "the API may be unreachable".
     *
     * Unlike the API's, this one cannot be scoped to a route: Next applies it
     * to every Server Action, which here includes three UNAUTHED ones — public
     * booking, login, and manage-booking. Their ceiling goes from 1MB to 3MB
     * as a side effect, with no middleware rate limit in front of them. That is
     * the cost of Next having no per-action setting; it is 3x, not 30x, and the
     * API's own limits still refuse anything those actions forward.
     *
     * The reachable large payload is the studio's paste-a-URL field, which
     * takes a `data:` URL of any length up to the zod cap — an upload is
     * downscaled to tens of kilobytes long before it gets here.
     *
     * This MUST equal `MAX_REQUEST_BODY` in `@slate/types`, and is written out
     * rather than imported: Next loads this file as bare Node ESM, where the
     * workspace packages' extensionless specifiers do not resolve. The two are
     * held together by a test (`lib/body-limit.spec.ts`).
     */
    serverActions: { bodySizeLimit: '3mb' },
  },
  // Anchor Turbopack to this monorepo (a stray lockfile elsewhere can mislead it).
  turbopack: {
    root: join(here, '..', '..'),
  },
};

export default nextConfig;
