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
  // Readable browser stack traces in error tracking, opt-in at BUILD time:
  // `PRODUCT_ANALYTICS_SOURCEMAPS=1` emits a `.map` beside each browser chunk,
  // for a deployment to upload to its analytics provider. The web Dockerfile
  // deletes every one before the image is assembled; any other build path (a
  // plain `next build` and `next start`, a platform's build) SERVES them from
  // `/_next/static` unless its own pipeline deletes them after the upload.
  // Unset (every bare fork): no maps, as before.
  productionBrowserSourceMaps: process.env.PRODUCT_ANALYTICS_SOURCEMAPS === '1',
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
    /**
     * Next 16.4 added upgrade reminders to `next dev` and `next build`. When a
     * coding agent runs either one and a reminder is due (by default, when the
     * installed Next has a security advisory), the command STOPS until the
     * agent reports the upgrade, so a build or test run halts on a notice
     * instead of on our code. Upgrades arrive here through Dependabot
     * and a reviewed PR, so the reminders are off. This changes only those CLI
     * reminders, not the server.
     */
    agentUpgrade: false,
  },
  // Anchor Turbopack to this monorepo (a stray lockfile elsewhere can mislead it).
  turbopack: {
    root: join(here, '..', '..'),
  },
  // "MCP & API" moved from a Settings tab to the rail, where connecting an
  // agent is now its own page. The old address is in bookmarks and older docs,
  // so it keeps working as a real HTTP redirect to that page, answered before
  // any page renders (the pages at both addresses redirect too, for anything
  // that reaches them anyway). `/admin/developers` holds no page of its own.
  // Temporary, not permanent: a browser caches a 308 forever, and either path
  // may hold a page of its own one day.
  async redirects() {
    return [
      { source: '/admin/settings/developer', destination: '/admin/developers/connect', permanent: false },
      { source: '/admin/developers', destination: '/admin/developers/connect', permanent: false },
    ];
  },
};

export default nextConfig;
