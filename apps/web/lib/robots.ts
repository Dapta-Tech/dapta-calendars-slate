import type { MetadataRoute } from 'next';
import { PRODUCT_PREFIXES } from '@/lib/theme';

/**
 * What `robots.txt` says (served by `app/robots.ts`).
 *
 * Indexable deployment: everything is open except the product, which is the
 * same list the theme and the framing policy call the product
 * (`PRODUCT_PREFIXES`: the dashboard, sign-in, onboarding and every API and
 * auth route). Booking pages are what this site is for, so they stay crawlable.
 *
 * Each product path is closed three ways (the bare path, its subtree, and the
 * bare path with a query) rather than as a plain prefix, because a robots rule
 * IS a prefix: `Disallow: /login` would also close `/login-labs/ana`, and
 * `login-labs` is a vanity slug an account may claim. Only the exact words are
 * reserved (`RESERVED_PUBLIC_SLUGS`).
 *
 * The private link pages (`/manage/...`, `/booking/...`) are left out on
 * purpose: each already says `noindex`, and a crawler kept out by robots.txt
 * would never read that.
 *
 * Noindexed deployment (`NOINDEX`): nothing at all.
 */
export function robotsPolicy(noindex: boolean): MetadataRoute.Robots {
  if (noindex) return { rules: { userAgent: '*', disallow: '/' } };
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: PRODUCT_PREFIXES.flatMap((path) => [`${path}$`, `${path}/`, `${path}?`]),
    },
  };
}
