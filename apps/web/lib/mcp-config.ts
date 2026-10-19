import 'server-only';

/**
 * Where an agent should connect, resolved from the SERVER's runtime environment.
 *
 * Never a `NEXT_PUBLIC_*` value: Next inlines those into the bundle at build time
 * and one image serves dev and prd, so a build-time URL would point one of them at
 * the other. This module is imported only by server components and the page reads
 * it per request (`force-dynamic`).
 *
 *   MCP_PUBLIC_URL  the full MCP endpoint, e.g. https://calendar.example.com/mcp
 *   API_PUBLIC_URL  the API's public origin; `/docs` and `/openapi.json` hang off it
 *                   and, when MCP_PUBLIC_URL is unset, so does `/mcp`.
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

function clean(v: string | undefined): string | null {
  const s = v?.trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return trimSlash(u.toString());
  } catch {
    return null;
  }
}

export function resolveMcpConfig(env: Record<string, string | undefined> = process.env): McpConfig {
  const fallback = env.NODE_ENV === 'production' ? null : 'http://localhost:4000';
  const explicitMcp = clean(env.MCP_PUBLIC_URL);
  const apiOrigin = clean(env.API_PUBLIC_URL) ?? (explicitMcp ? new URL(explicitMcp).origin : fallback);
  const mcpUrl = explicitMcp ?? (apiOrigin ? `${apiOrigin}/mcp` : null);
  return { mcpUrl, apiOrigin };
}
