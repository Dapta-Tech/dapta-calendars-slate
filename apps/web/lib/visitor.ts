import 'server-only';
import { headers } from 'next/headers';
import { visitorForwardHeaders } from '@slate/shared';
import { internalApiSecret } from '@/lib/internal-secret';

/**
 * How many reverse proxies in front of the web app append to
 * `X-Forwarded-For`, read the same way the API reads it (default 1, one load
 * balancer; 0 means none, and then the visitor's address is not known here).
 */
function trustedHops(): number {
  const n = Number(process.env.RATE_LIMIT_TRUSTED_PROXY_HOPS ?? 1);
  return Number.isInteger(n) && n >= 0 && n <= 10 ? n : 1;
}

/**
 * The headers that tell the API which visitor a server-side call is for.
 *
 * The web app calls the API from its own server, so without these every
 * visitor of every booking page shares the web server's rate-limit bucket.
 * With INTERNAL_API_SECRET set (the same value on the API), each call carries
 * the visitor's address beside the secret, and the API counts the visitor.
 * Empty when the secret is unset or too short for the API to accept (the
 * startup warning in instrumentation.ts says so), outside a request, or when
 * the address is not known: the API then keys on the web server, as it always
 * did.
 */
export async function visitorHeaders(): Promise<Record<string, string>> {
  const secret = internalApiSecret();
  if (!secret) return {};
  let xff: string | null;
  try {
    xff = (await headers()).get('x-forwarded-for');
  } catch {
    return {};
  }
  return visitorForwardHeaders(xff, trustedHops(), secret);
}
