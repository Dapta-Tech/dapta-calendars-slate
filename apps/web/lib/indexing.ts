/**
 * Whether search engines may index this deployment at all.
 *
 * `NOINDEX` (1|true|yes) marks a WHOLE deployment as not for search: a staging
 * or preview copy whose booking pages are real enough to rank and must never
 * compete with production. Unset, which is every bare fork, the site is
 * indexable as usual and `robots.txt` only keeps crawlers out of the product.
 *
 * Read from the RUNTIME env on every request, never inlined at build time, so
 * one image serves a noindexed staging and an indexed production. Three readers
 * share it: the middleware (`X-Robots-Tag` on every response), the root layout
 * (`<meta name="robots">`) and `app/robots.ts` (`Disallow: /`).
 *
 * Edge-safe on purpose (no `next/headers`): the middleware imports it.
 */
export function deploymentNoindex(): boolean {
  return /^(1|true|yes)$/i.test((process.env.NOINDEX ?? '').trim());
}

/** The header value a noindexed deployment answers every request with. */
export const NOINDEX_HEADER_VALUE = 'noindex, nofollow';
