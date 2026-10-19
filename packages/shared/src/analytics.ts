/**
 * Product analytics: the deployment's OWN telemetry about how Calendars is
 * used. Vendor-neutral and shared by the API (server events) and the web app
 * (browser events), so both halves name things the same way.
 *
 * Who is measured, and how:
 *  - HOSTS (the people who sign in) are identified by their email, the way the
 *    rest of a platform usually knows them, so one person is one person across
 *    products that share an analytics project.
 *  - VISITORS of a public booking page are never identified. Their events are
 *    anonymous counts, carry no name, email, phone or answer, and are tied to
 *    the ACCOUNT whose page they are on, never to a person.
 *
 * Off by default. A deployment with no analytics configured (every bare fork)
 * loads no script, enqueues nothing and makes no request: `resolveAnalyticsConfig`
 * answers `null` and every caller treats that as "do nothing".
 */

/**
 * Every event name carries this prefix. Analytics projects are often shared
 * between products, and an unprefixed `signup_completed` would silently merge
 * with another product's event of the same name. Applied centrally (see
 * `analyticsEventName`), never typed at a call site.
 */
export const ANALYTICS_EVENT_PREFIX = 'calendars_';

/**
 * The group every event belongs to: the Calendars ACCOUNT (workspace). Most
 * launch questions are about accounts, not people ("how many accounts got a
 * first booking"). Named per product so its id space never collides with
 * another product's in a shared project.
 */
export const ANALYTICS_GROUP_TYPE = 'calendars_account';

/** Super property on every event, so this product's events are separable. */
export const ANALYTICS_PRODUCT = 'calendars';

/**
 * Events the API emits. Each fires where the change is committed, so it is
 * true even when the browser never sees it (an API key, an agent, a retry).
 */
export const SERVER_ANALYTICS_EVENTS = [
  'signup_completed',
  'attribution_captured',
  'template_chosen',
  'calendar_connected',
  'hours_set',
  'event_type_published',
  'branding_changed',
  'hide_branding_toggled',
  'booking_created',
] as const;
export type ServerAnalyticsEvent = (typeof SERVER_ANALYTICS_EVENTS)[number];

/** Events the browser emits: things only the page can see. */
export const BROWSER_ANALYTICS_EVENTS = [
  // Host, signed in.
  'template_skipped',
  'link_copied',
  // Visitor, anonymous.
  'booking_page_viewed',
  'day_picked',
  'slot_picked',
  'booking_submitted',
  'booking_confirmed',
  'cta_clicked',
] as const;
export type BrowserAnalyticsEvent = (typeof BROWSER_ANALYTICS_EVENTS)[number];

export type AnalyticsEvent = ServerAnalyticsEvent | BrowserAnalyticsEvent;

/** Event properties: small, flat, and never personal. */
export type AnalyticsProps = Record<string, string | number | boolean | null>;

/** The wire name of an event: the product prefix plus the event. */
export function analyticsEventName(event: AnalyticsEvent): string {
  return `${ANALYTICS_EVENT_PREFIX}${event}`;
}

/* --------------------------------------------------------------- config */

/**
 * Adapters this repo ships. One today; the port (`AnalyticsProvider` in the
 * API, `AnalyticsPort` in the web app) is what a fork implements to add one.
 */
export const ANALYTICS_PROVIDERS = ['none', 'posthog'] as const;
export type AnalyticsProviderName = (typeof ANALYTICS_PROVIDERS)[number];

/** The vendor's own public ingestion host, used when none is configured. */
export const POSTHOG_DEFAULT_HOST = 'https://us.i.posthog.com';

/**
 * Key prefixes that name a READ credential (PostHog's personal API keys). The
 * ingestion key reaches every public page by design, so a read key pasted into
 * its place would be published; it is refused instead, and analytics stays off.
 */
const READ_KEY_PREFIXES = ['phx_'];

/** A usable analytics configuration. `null` everywhere means "off". */
export interface AnalyticsConfig {
  provider: Exclude<AnalyticsProviderName, 'none'>;
  /** The project's write-only ingestion key. Public by design, never a read credential. */
  key: string;
  /** Ingestion host, without a trailing slash. */
  host: string;
}

function clean(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * Read the analytics configuration, or `null` when it is off.
 *
 * Off unless BOTH a known provider and a key are set. A provider without a key
 * is a half-done deployment, and the answer to it is "off", never a refusal to
 * boot: analytics observes the product and must never be able to stop it.
 * A host that is not http(s) is refused the same way, since the browser would
 * otherwise be told to load a script from it.
 */
export function resolveAnalyticsConfig(env: {
  provider?: string | null;
  key?: string | null;
  host?: string | null;
}): AnalyticsConfig | null {
  const provider = clean(env.provider)?.toLowerCase();
  const key = clean(env.key);
  if (provider !== 'posthog' || !key) return null;
  if (READ_KEY_PREFIXES.some((p) => key.toLowerCase().startsWith(p))) return null;
  const host = (clean(env.host) ?? POSTHOG_DEFAULT_HOST).replace(/\/+$/, '');
  if (!/^https?:\/\/[^/?#\s]+(\/[^?#\s]*)?$/i.test(host)) return null;
  return { provider, key, host };
}

/* ------------------------------------------------------- internal users */

/**
 * Parse the deployment's internal-email patterns (comma-separated). Each one is
 * a case-insensitive SUBSTRING of the email, the same reading as an SQL
 * `ILIKE '%pattern%'`, so an operator can name a domain fragment (`example`),
 * a whole domain (`@example.com`) or one address.
 */
export function parseInternalEmailPatterns(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0);
}

/**
 * Is this email one of the operator's own people (staff, test accounts)?
 *
 * Sent as `is_internal` on every host event from the first day, so launch
 * numbers can leave the operator's own use out without a cleanup later. With
 * no patterns configured nobody is internal, which is right for a fork.
 */
export function isInternalEmail(email: string | null | undefined, patterns: readonly string[]): boolean {
  if (!email || patterns.length === 0) return false;
  const lower = email.toLowerCase();
  return patterns.some((p) => lower.includes(p));
}

/* ------------------------------------------ landing visitor id (ph_id) */

/**
 * The query key a marketing landing uses to hand over its anonymous analytics
 * id, so "visited the landing, then signed up" is one person rather than two.
 * The landing and this app are different origins, so the vendor's own cookie
 * does not cross.
 */
export const LANDING_ID_QUERY_KEY = 'ph_id';

/**
 * Where the middleware parks that id for the login round trip. Same ten-minute
 * life as the attribution cookie it travels beside (`ATTRIBUTION_WINDOW_MS`).
 */
export const LANDING_ID_COOKIE = 'slate.ph_id';

/**
 * A landing id fit to carry, or null.
 *
 * Strict on purpose: anyone can put anything after `?ph_id=`, and the only
 * legitimate producer is an analytics snippet whose ids are UUID-shaped. The
 * allowlist covers those (hex, dashes, and a `$device:`-style prefix) and
 * refuses everything else; losing the join for an exotic id is a shrug,
 * forwarding arbitrary text into cookies and analytics calls is not.
 */
export function sanitizeLandingDistinctId(raw: string | readonly string[] | null | undefined): string | null {
  const value = (typeof raw === 'string' ? raw : raw?.[0]) ?? '';
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 200) return null;
  return /^[A-Za-z0-9$:._-]+$/.test(trimmed) ? trimmed : null;
}

/* ----------------------------------------------------- campaign values */

/** The longest campaign tag sent. Campaign names are labels, never prose. */
export const CAMPAIGN_VALUE_MAX = 100;

/**
 * The characters a campaign label is made of, checked after Unicode
 * compatibility folding: letters (not modifier letters, which include colon
 * lookalikes), combining marks, digits in any script, the space, and a short
 * list of punctuation. An ALLOWLIST, so a character nobody thought of (a
 * lookalike colon or slash, an invisible format character, a backslash, a
 * semicolon) is refused by construction rather than by one more rule.
 */
const CAMPAIGN_CHARS = /^[\p{Ll}\p{Lu}\p{Lt}\p{Lo}\p{Mn}\p{Mc}\p{Nd} ._&#%+/'()!,*|~:-]+$/u;

/**
 * A campaign tag fit to send to analytics, or null.
 *
 * Campaign tags are whatever a link builder typed after `utm_*=`, and the only
 * check upstream is a length cap. A tag can therefore carry an email address
 * or a handle, a URL, a query, an HTML entity or a phone number from a merge
 * tag, none of which is a campaign label. Those are withheld rather than
 * cleaned: a guessed repair would be a value nobody chose.
 *
 * Withheld: any character outside `CAMPAIGN_CHARS` (so `@`, `?`, `=`, `;`,
 * `\`, lookalikes and invisible characters); a colon not followed by a space
 * (`tel:`, `mailto:`, a port, `a:b:c`; "q3: launch" is kept); two slashes
 * anywhere, or a dotted host followed by a slash (a URL or a path); an HTML
 * numeric entity (`&#64`, with or without its `;`); a phone number (nine or
 * more digits in groups, or led by `+`, anywhere in the value); an `%u`
 * escape; anything past `CAMPAIGN_VALUE_MAX`.
 *
 * Kept, on purpose: an unbroken run of digits, which cannot be told from a
 * numeric campaign id (an ad platform's `{campaignid}`). That includes a phone
 * whose `+` was not URL-encoded: the query parser turns it into a space.
 *
 * The value has been decoded once already, so a `%XX` run that still decodes
 * is an encoding left over: it is decoded and the result checked again, once
 * (a value encoded three times is refused). A `%` that is not an encoding
 * ("20%descuento") is a literal percent and stays.
 */
export function analyticsCampaignValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return campaignLabel(value.trim(), 0);
}

function campaignLabel(v: string, depth: number): string | null {
  if (!v || v.length > CAMPAIGN_VALUE_MAX) return null;
  const folded = v.normalize('NFKC');
  if (/%u[0-9a-f]{4}/i.test(folded)) return null;
  let decodedSome = false;
  const decoded = folded.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    try {
      const out = decodeURIComponent(run);
      decodedSome = true;
      return out;
    } catch {
      return run;
    }
  });
  if (decodedSome) return depth === 0 ? campaignLabel(decoded.trim(), 1) : null;
  if (!CAMPAIGN_CHARS.test(folded)) return null;
  if (/:(?!\s)|\/\/|\/.*\//.test(folded)) return null;
  if (/[\p{L}\p{N}-]\.[\p{L}\p{N}-]*\//u.test(folded)) return null;
  if (/&#x?[0-9a-f]/i.test(folded)) return null;
  if (looksLikePhone(folded)) return null;
  return v;
}

/** Nine or more digits that are grouped (or led by `+`), anywhere in the value. */
function looksLikePhone(v: string): boolean {
  for (const m of v.matchAll(/\+?\p{Nd}[\p{Nd} ()./_-]*\p{Nd}/gu)) {
    const run = m[0];
    const digits = run.match(/\p{Nd}/gu)?.length ?? 0;
    if (digits >= 9 && (run.startsWith('+') || /[ ()./_-]/.test(run))) return true;
  }
  return false;
}

/* ----------------------------------------------------------- referrers */

/**
 * The host of a referrer URL, lower-cased, or null. Analytics gets the domain
 * ("chatgpt.com", "google.com") and never the full URL, whose path and query
 * can carry anything the referring page put there.
 */
export function referrerDomain(referer: string | null | undefined): string | null {
  // The authority's user part (`user@`) is not the domain and can be a person.
  const m = /^https?:\/\/(?:[^/?#]*@)?([^/?#:@]+)/i.exec((referer ?? '').trim());
  const host = m?.[1]?.toLowerCase() ?? null;
  // Only what a browser can send as a host name; anything else is not a domain.
  return host && /^[a-z0-9.-]+$/.test(host) ? host : null;
}
