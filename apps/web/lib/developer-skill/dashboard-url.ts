import type { NextRequest } from 'next/server';
import { requestOrigin } from '../request-origin';

/**
 * The dashboard's public base URL, for the links the skill writes (the API keys
 * and API docs pages). Path prefix included: a deployment served under
 * `https://example.com/calendars` must get links under that prefix, the same
 * rule the API follows when it builds booking links from `PUBLIC_APP_URL`.
 *
 * `PUBLIC_APP_URL` first: it is the deployment's own statement of where the
 * dashboard lives, the one the API already writes into booking and manage
 * links, and it cannot be bent by a request header. The request's own origin
 * (proxy headers, then its URL, as the auth routes build redirects) only when
 * it is unset or unusable, as on a bare clone.
 */
export function dashboardUrl(req: NextRequest, env: Record<string, string | undefined> = process.env): string {
  const configured = env.PUBLIC_APP_URL?.trim();
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol === 'https:' || url.protocol === 'http:') return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
    } catch {
      // A malformed value falls through to the request, rather than failing the download.
    }
  }
  return requestOrigin(req);
}
