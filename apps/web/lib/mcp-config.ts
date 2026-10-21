import 'server-only';
import { cleanPublicUrl } from '@slate/config/env';

/**
 * Where an agent should connect, resolved from the SERVER's runtime environment.
 *
 * Never a `NEXT_PUBLIC_*` value: Next inlines those into the bundle at build time
 * and one image serves dev and prd, so a build-time URL would point one of them at
 * the other. This module is imported only by server components and the page reads
 * it per request (`force-dynamic`).
 *
 *   MCP_PUBLIC_URL  the full MCP endpoint, e.g. https://calendar.example.com/mcp
 *   API_PUBLIC_URL  the API's public base URL (path prefix included); `/docs` and
 *                   `/openapi.json` hang off it and, when MCP_PUBLIC_URL is unset,
 *                   so does `/mcp`. Unset, it is the MCP address minus its final
 *                   `/mcp` (see `apiFromMcp`).
 *
 * A bare clone gets the local API (`http://localhost:4000`); a production process
 * with neither set gets `null`, and the page says so instead of showing a
 * localhost address nobody can reach.
 */
export interface McpConfig {
  mcpUrl: string | null;
  apiOrigin: string | null;
}

const trimSlash = (s: string) => s.replace(/\/+$/, '');

/** The same normalization the API applies to its own API_PUBLIC_URL. */
const clean = (v: string | undefined): string | null => cleanPublicUrl(v) ?? null;

/**
 * The API base an MCP address implies: the address minus its final `/mcp`, so a
 * deployment under a path prefix (`https://host/calendar/mcp`) keeps the prefix
 * and every REST link built on it still lands. An address that does not end in
 * `/mcp` says nothing about where the API lives, so only its origin is taken.
 */
function apiFromMcp(mcpUrl: string): string {
  const u = new URL(mcpUrl);
  return u.pathname.endsWith('/mcp') ? trimSlash(`${u.origin}${u.pathname.slice(0, -'/mcp'.length)}`) : u.origin;
}

export function resolveMcpConfig(env: Record<string, string | undefined> = process.env): McpConfig {
  const fallback = env.NODE_ENV === 'production' ? null : 'http://localhost:4000';
  const explicitMcp = clean(env.MCP_PUBLIC_URL);
  const apiOrigin = clean(env.API_PUBLIC_URL) ?? (explicitMcp ? apiFromMcp(explicitMcp) : fallback);
  const mcpUrl = explicitMcp ?? (apiOrigin ? `${apiOrigin}/mcp` : null);
  return { mcpUrl, apiOrigin };
}
