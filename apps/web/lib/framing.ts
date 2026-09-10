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
/**
 * The decision is made on the PATH ALONE, not on `?embed=1`.
 *
 * The middleware has the query in hand and could open the booking routes only
 * for an embedded render, which would be the narrower policy. It does not,
 * because #67 chose to say "a public booking page is embeddable" rather than
 * "an embedded booking page is embeddable" — a host who hand-writes an iframe
 * without the mode, or frames a page whose 308 has not resolved yet, still gets
 * a page rather than a blocked frame. The residual exposure is a full-chrome
 * booking page being framed, where the attacker's payoff is a victim who types
 * their own name and email into a real booking form on the real host's
 * calendar.
 *
 * If this is ever tightened to `embed=1`, the header then varies by query, so
 * whatever caches these responses has to include the query in its key. It does
 * today, but that becomes load-bearing rather than incidental.
 */
export function frameAncestorsFor(path: string): FrameAncestors {
  // Reads `isProductPath`, which means that function's prefix list is now a
  // security boundary as well as a palette switch. Its own comment says so, and
  // `framing.spec.ts` pins every entry to `'self'` so removing one breaks a
  // test rather than a header.
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
