/**
 * Growth loop — the "Made with Dapta Calendars" attribution on public pages.
 *
 * Open-core rule: like the app-switcher's platform URL, the signup destination
 * comes ONLY from the deployment (NEXT_PUBLIC_SIGNUP_URL) — no internal host
 * is hardcoded in the open tree (publish-gate). Unset → the badge/CTA don't
 * render, so a bare fork carries no Dapta branding and no dead link; Dapta's
 * cloud sets it and can still opt out per deployment with the hide flag.
 * All URL construction is pure here so the UTM scheme is testable and
 * identical on every surface.
 */

/** UTM values are fixed product-wide; only the medium varies by surface. */
export type SignupMedium = 'badge' | 'confirmation';

export const UTM_SOURCE = 'dapta-calendars';
export const UTM_CAMPAIGN = 'made-with-dapta';

/**
 * The signup destination carrying the growth-loop UTM tags, or null when no
 * (or a non-http(s)) base is configured — callers hide the surface then.
 * `accountCode` (already public — it's in the page URL) rides along as
 * utm_content for attribution; nothing else about the tenant is leaked.
 * String-built (no URL/URLSearchParams): this package stays lib-ES2022-only.
 */
export function buildSignupUrl(opts: {
  baseUrl?: string | null;
  medium: SignupMedium;
  accountCode?: string | null;
}): string | null {
  const base = (opts.baseUrl ?? '').trim();
  if (!/^https?:\/\/\S+$/i.test(base)) return null;
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

/* --------------------------------------------------------------------------
 * O2 — inbound attribution: the explicit 7-key allowlist (#65 → refinement).
 * ------------------------------------------------------------------------ */

/**
 * The ONLY parameters ever carried from a campaign click into an account's
 * permanent attribution row. An explicit allowlist, never a `utm_*` glob.
 *
 * The claim downstream is WRITE-ONCE: whatever lands here is stamped on the
 * account permanently and cannot be un-stamped, so a glob turns
 * `?utm_anything=<junk>` into a one-shot poisoning of that account's row.
 *
 * Why each key is on the list:
 *  - source/medium/campaign — the three the `dapta_sync` payload actually reads;
 *  - term/content — `content` in particular, because `buildSignupUrl` above
 *    already emits `utm_content=<accountCode>` from every booking page badge.
 *    Dropping it would blind the viral edge on the receiving side while the
 *    emitting side keeps stamping it;
 *  - gclid/fbclid — paid click ids.
 */
export const ATTRIBUTION_KEYS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'gclid',
  'fbclid',
] as const;

export type AttributionKey = (typeof ATTRIBUTION_KEYS)[number];

/** UTM values are case-insensitive labels; click ids are opaque and are not. */
const LOWERCASED_KEYS: ReadonlySet<string> = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
]);

/**
 * Per-value ceiling. Long enough for any real campaign name, short enough that
 * seven maxed-out values cannot bloat a row written once and kept forever.
 */
export const ATTRIBUTION_VALUE_MAX = 128;

/** Ceiling on the serialized blob, belt-and-braces over the per-value cap. */
export const ATTRIBUTION_BLOB_MAX = 1024;

/**
 * What gets parked, and later claimed onto the account.
 *
 * `referer` is deliberately NOT an `AttributionKey`: it never comes from a
 * query parameter (see `parseAttribution`), so it can never be part of the
 * allowlist that governs them.
 */
export type Attribution = Partial<Record<AttributionKey, string>> & {
  /** Cross-origin referrer, read from the request HEADER only. */
  referer?: string;
};

/** Case-insensitive lookup over whatever shape the caller holds params in. */
export type AttributionParamSource =
  | Record<string, string | string[] | undefined>
  | { get(key: string): string | null };

function readParam(src: AttributionParamSource, key: string): string | undefined {
  if (typeof (src as { get?: unknown }).get === 'function') {
    return (src as { get(k: string): string | null }).get(key) ?? undefined;
  }
  const v = (src as Record<string, string | string[] | undefined>)[key];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Trim → drop-if-empty → case-fold (utm only) → cap. Returns undefined when the
 * value carries nothing worth keeping.
 */
function normalizeValue(key: string, raw: string | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const folded = LOWERCASED_KEYS.has(key) ? trimmed.toLowerCase() : trimmed;
  return folded.slice(0, ATTRIBUTION_VALUE_MAX);
}

/**
 * The HOST of an absolute http(s) URL, or null when it isn't one.
 *
 * Host, deliberately, not origin. A deployment terminating TLS at a proxy sees
 * its own requests as `http://` while the browser sends an `https://` referrer,
 * so comparing full origins would call internal navigation cross-origin and
 * stamp every organic signup with a self-referral — permanently, since the
 * claim is write-once. The port rides along so `localhost:3000` and
 * `localhost:3111` stay distinct instances in dev.
 */
function hostOf(url: string): string | null {
  const m = /^https?:\/\/([^/?#]+)/i.exec(url.trim());
  const host = m?.[1];
  return host ? host.toLowerCase() : null;
}

/**
 * Build the attribution blob for one inbound request.
 *
 * Three rules, each load-bearing:
 *
 *  1. **Only the seven keys.** Everything else in the query string is dropped,
 *     a `referer` parameter included — see (2).
 *  2. **`referer` is read from the HEADER, and only when cross-origin.** A
 *     caller-supplied `referer` param is attacker-controlled text and would be
 *     indistinguishable from the real thing once claimed. A same-origin
 *     referrer is internal navigation and says nothing about acquisition.
 *  3. **No synthetic fallback.** Organic traffic yields an EMPTY result — no
 *     `utm_source=direct`, no `utm_medium=organic`. Someone who typed the
 *     domain has no campaign, and stamping one writes a permanent lie into a
 *     row that can never be corrected. Absent UTMs plus a cross-origin referer
 *     is the honest representation of organic, and the funnel reads it as such.
 *
 * Returns `null` when nothing at all was captured, so callers skip parking
 * rather than park an empty object.
 */
export function parseAttribution(opts: {
  params: AttributionParamSource;
  /** The `referer` request header, verbatim. */
  refererHeader?: string | null;
  /**
   * This request's own PUBLIC origin, e.g. `https://calendar.dapta.ai`.
   *
   * It must be derived from the proxy headers, never from the raw request URL:
   * behind a load balancer the latter is the server's bind address, and the
   * same-origin check would then miss on internal navigation.
   */
  selfOrigin?: string | null;
}): Attribution | null {
  const out: Attribution = {};
  for (const key of ATTRIBUTION_KEYS) {
    const value = normalizeValue(key, readParam(opts.params, key));
    if (value) out[key] = value;
  }

  const referer = (opts.refererHeader ?? '').trim();
  if (referer) {
    const from = hostOf(referer);
    const self = opts.selfOrigin ? hostOf(opts.selfOrigin) : null;
    if (from && from !== self) out.referer = referer.slice(0, ATTRIBUTION_VALUE_MAX);
  }

  if (Object.keys(out).length === 0) return null;
  if (JSON.stringify(out).length <= ATTRIBUTION_BLOB_MAX) return out;

  // Pathological input: keep a prefix rather than the whole thing. Insertion
  // order follows ATTRIBUTION_KEYS, so source/medium/campaign — the three the
  // payload actually reads — survive and the long tail is what gets lost.
  const bounded: Attribution = {};
  for (const [k, v] of Object.entries(out)) {
    if (JSON.stringify({ ...bounded, [k]: v }).length > ATTRIBUTION_BLOB_MAX) break;
    Object.assign(bounded, { [k]: v });
  }
  return Object.keys(bounded).length ? bounded : null;
}

/** Cookie the middleware parks the blob in, claimed after the login round-trip. */
export const ATTRIBUTION_COOKIE = 'slate.attribution';

/**
 * The parked cookie's lifetime AND the account-age window the claim enforces.
 * One constant, because they are the same ten minutes (#65 → Growth funnel):
 * a campaign click by the owner of an older workspace must never stamp it.
 */
export const ATTRIBUTION_WINDOW_MS = 10 * 60_000;
