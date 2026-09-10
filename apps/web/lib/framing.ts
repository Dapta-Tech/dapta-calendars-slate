import { isProductPath } from '@/lib/theme';

/**
 * Who may put this page in an iframe (E, from #67).
 *
 * The repo had no framing policy at all before this: `next.config.mjs` defines
 * no `headers()`, so embedding worked by OMISSION — and so did framing of
 * `/admin/*` and `/manage/[uid]`, the host's dashboard and the page where an
 * invitee cancels or reschedules. Both were frameable by any site, which is the
 * standard precondition for clickjacking.
 *
 * Shipping an embed turns "frameable" from an accident into a promise, and the
 * promise is only safe if its complement is written down at the same time.
 * Without the negative half, a later security-headers pass either breaks the
 * embed or leaves the dashboard open.
 *
 * This lives in the middleware rather than in `next.config.mjs` because the
 * public booking routes are `/{accountCode}/{handle}/{slug}` — dynamic segments
 * that cannot be enumerated as a `headers()` source pattern without also
 * matching `/login` and `/onboarding`. The middleware already runs on every
 * page request and already has the product/public split this needs.
 */

/** Paths that are the host's own surface even though they render on the
 *  booking canvas. `/manage/[uid]` is the one that matters: an invitee cancels
 *  or reschedules there, one click, from an emailed link. */
const SELF_ONLY_PREFIXES = ['/manage'];

export type FrameAncestors = "'self'" | '*';

/**
 * `*` for the four public booking routes, `'self'` for everything the host or
 * the invitee acts on.
 *
 * The default falls on the PUBLIC side, matching `isProductPath`'s existing
 * reasoning: the booking routes are dynamic and cannot be listed, so an
 * unmatched path gets `*` and renders a 404 — visible and harmless. The
 * mirror-image default would let a new admin route quietly become frameable,
 * which nobody notices.
 */
export function frameAncestorsFor(path: string): FrameAncestors {
  if (isProductPath(path)) return "'self'";
  if (SELF_ONLY_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) return "'self'";
  return '*';
}

/**
 * The headers to stamp on a page response.
 *
 * `X-Frame-Options` is set ONLY on the `'self'` side. It is the legacy header,
 * still read by browsers that predate `frame-ancestors`, and it costs nothing
 * where the answer is same-origin. It has no way to say "anyone": `ALLOW-FROM`
 * is dead and `SAMEORIGIN` would break the embed in exactly the old browsers
 * that still honour it — so the public routes carry the CSP alone.
 */
export function framingHeaders(path: string): Record<string, string> {
  const ancestors = frameAncestorsFor(path);
  const headers: Record<string, string> = {
    'Content-Security-Policy': `frame-ancestors ${ancestors}`,
  };
  if (ancestors === "'self'") headers['X-Frame-Options'] = 'SAMEORIGIN';
  return headers;
}
