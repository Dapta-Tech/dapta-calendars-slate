import type { ApiScope } from '@slate/types';

/**
 * Small pieces shared by the MCP door and the external authorization server
 * client (`external.service.ts`). This API is an OAuth resource server only;
 * it runs no authorization server of its own.
 */

/**
 * The scopes a sign-in acts with: exactly the ones the MCP tools check, so it
 * never holds more than the tools use. (`calendars:read` exists for API keys on
 * the REST surface; no MCP tool reads it.)
 */
export const OAUTH_SCOPES = [
  'event-types:read',
  'availability:read',
  'bookings:read',
  'bookings:write',
  'bookings:cancel',
] as const satisfies readonly ApiScope[];
export type OAuthScope = (typeof OAUTH_SCOPES)[number];

/**
 * A URL without its trailing slashes (an origin, or a path). A loop, not
 * `/\/+$/`: some inputs come from a request (an `Origin` header), and that
 * regex is quadratic on a long run of slashes (CodeQL js/polynomial-redos).
 */
export function trimSlash(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47) end -= 1;
  return url.slice(0, end);
}

/** RFC 9728 §3.1: the metadata URL inserts `/.well-known/oauth-protected-resource` before the resource path. */
export function resourceMetadataUrlFor(resource: string): string {
  const url = new URL(resource);
  const path = trimSlash(url.pathname);
  return `${url.origin}/.well-known/oauth-protected-resource${path}`;
}
