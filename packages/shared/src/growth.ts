/**
 * Growth loop — the "Made with Dapta Calendars" attribution on public pages.
 *
 * Open-core rule: the badge shows by default and any fork can turn it off with
 * a single env flag (no code change). All URL construction is pure here so the
 * UTM scheme is testable and identical on every surface.
 */

/** Where the badge/CTA send visitors when no NEXT_PUBLIC_SIGNUP_URL is set. */
export const DEFAULT_SIGNUP_URL = 'https://app.dapta.ai';

/** UTM values are fixed product-wide; only the medium varies by surface. */
export type SignupMedium = 'badge' | 'confirmation';

export const UTM_SOURCE = 'dapta-calendars';
export const UTM_CAMPAIGN = 'made-with-dapta';

/**
 * The signup destination carrying the growth-loop UTM tags.
 * `accountCode` (already public — it's in the page URL) rides along as
 * utm_content for attribution; nothing else about the tenant is leaked.
 * A base that isn't an http(s) URL falls back to the default destination.
 * String-built (no URL/URLSearchParams): this package stays lib-ES2022-only.
 */
export function buildSignupUrl(opts: {
  baseUrl?: string | null;
  medium: SignupMedium;
  accountCode?: string | null;
}): string {
  const raw = (opts.baseUrl ?? '').trim();
  const base = /^https?:\/\/\S+$/i.test(raw) ? raw : DEFAULT_SIGNUP_URL;
  const pairs: Array<[string, string]> = [
    ['utm_source', UTM_SOURCE],
    ['utm_medium', opts.medium],
    ['utm_campaign', UTM_CAMPAIGN],
  ];
  if (opts.accountCode) pairs.push(['utm_content', opts.accountCode]);
  const query = pairs.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  // Preserve an existing query and keep any fragment at the very end.
  const hashAt = base.indexOf('#');
  const path = hashAt === -1 ? base : base.slice(0, hashAt);
  const hash = hashAt === -1 ? '' : base.slice(hashAt);
  return `${path}${path.includes('?') ? '&' : '?'}${query}${hash}`;
}

/**
 * Parse the badge kill-switch (NEXT_PUBLIC_HIDE_BADGE). Truthy spellings
 * ("1", "true", "yes", any case) hide it; everything else keeps it on —
 * shown-by-default is the open-core contract.
 */
export function badgeHidden(flag: string | undefined | null): boolean {
  if (!flag) return false;
  return ['1', 'true', 'yes'].includes(flag.trim().toLowerCase());
}
