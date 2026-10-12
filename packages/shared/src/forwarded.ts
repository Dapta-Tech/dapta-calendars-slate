/**
 * The visitor's address as the reverse proxies in front of an app saw it, and
 * the headers the web app uses to hand it to the API.
 *
 * Every proxy APPENDS the address it received the connection from to
 * `X-Forwarded-For`, so only the rightmost `trustedHops` entries were written by
 * infrastructure; everything to their left came from the client and can be
 * rotated at will. With `trustedHops` proxies the client is the entry
 * `trustedHops` from the right. A header with fewer entries than that did not
 * pass through every proxy, so its leftmost entry is the best answer there is.
 * `trustedHops = 0`, or no header, answers null: the caller uses its socket.
 */
export function forwardedClient(xff: string | string[] | null | undefined, trustedHops: number): string | null {
  if (trustedHops <= 0 || xff == null) return null;
  const hops = (Array.isArray(xff) ? xff.join(',') : xff)
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  if (hops.length === 0) return null;
  return hops[Math.max(0, hops.length - trustedHops)]!;
}

/** Carries INTERNAL_API_SECRET on a server-side call from the web app to the API. */
export const INTERNAL_SECRET_HEADER = 'x-slate-internal';
/** The visitor's address on that call; the API trusts it only beside the secret. */
export const CLIENT_IP_HEADER = 'x-slate-client-ip';

/**
 * The headers a server-side call made on behalf of a visitor sends, so the API's
 * rate limiter counts the visitor rather than the web server. Empty when the
 * secret is unset (the feature is off) or the visitor's address is unknown.
 */
export function visitorForwardHeaders(
  xff: string | string[] | null | undefined,
  trustedHops: number,
  secret: string | undefined,
): Record<string, string> {
  if (!secret) return {};
  const client = forwardedClient(xff, trustedHops);
  return client ? { [INTERNAL_SECRET_HEADER]: secret, [CLIENT_IP_HEADER]: client } : {};
}
