import type { AnalyticsConfig, AnalyticsProps } from '@slate/shared';
import type { AnalyticsPort, AnalyticsSurface } from './port';

/**
 * The PostHog adapter behind the browser analytics port.
 *
 * Nothing bundled: the vendor's loader contract is installed by hand, and it
 * loads the real library from the configured host. `posthog-js` is only a
 * test dependency, so a feature that ships OFF costs a fork nothing, not even
 * bundle bytes, unless it turns analytics on.
 *
 * Each audience gets its own NAMED instance with its own settings, so a host
 * who opens their own booking page in the same tab is never reported as a
 * visitor with a name, and a visitor is never reported with the host's.
 */

/** One PostHog instance (real, or the stub's queue standing in for it). */
interface PosthogInstance {
  capture(event: string, properties?: Record<string, unknown>): void;
  identify(distinctId: string, properties?: Record<string, unknown>): void;
  alias(alias: string, original?: string): void;
  register(properties: Record<string, unknown>): void;
  group(type: string, key: string, properties?: Record<string, unknown>): void;
  reset(): void;
}

interface PosthogGlobal {
  __SV?: number;
  init(key: string, config: Record<string, unknown>, name: string): unknown;
  [instance: string]: unknown;
}

type PosthogWindow = Window & { posthog?: PosthogGlobal };

/** The vendor's event, as `before_send` receives it. */
interface CaptureEvent {
  event: string;
  properties?: Record<string, unknown>;
  $set?: Record<string, unknown>;
  $set_once?: Record<string, unknown>;
}

const INSTANCE_NAME: Record<AnalyticsSurface, string> = {
  host: 'calendars_host',
  visitor: 'calendars_visitor',
};

/** Where the host instance may report from: the dashboard and the wizard. */
const HOST_PATH = /^\/(admin|onboarding)(\/|$)/;

/**
 * What a VISITOR event may carry, and nothing else: an allowlist, so a vendor
 * release that starts sending something new sends it nowhere. Device and
 * session basics the vendor needs to accept and count an event, the page
 * (with its query cut), the referring DOMAIN, and this app's own properties.
 * Not here, on purpose: every campaign and click id, the session's entry URL
 * and entry referrer (the full ones, query included), debug timings.
 */
const VISITOR_PROPERTIES = new Set([
  'token',
  'distinct_id',
  '$device_id',
  '$session_id',
  '$window_id',
  '$insert_id',
  '$time',
  '$lib',
  '$lib_version',
  '$lib_custom_api_host',
  '$lib_rate_limit_remaining_tokens',
  '$sdk_dist_channel',
  '$config_defaults',
  '$configured_session_timeout_ms',
  '$is_identified',
  '$process_person_profile',
  '$recording_status',
  // The user agent travels in the request header regardless; the vendor's
  // bot filtering reads it from here.
  '$raw_user_agent',
  '$browser',
  '$browser_version',
  '$browser_language',
  '$browser_language_prefix',
  '$os',
  '$os_version',
  '$device',
  '$device_type',
  '$screen_height',
  '$screen_width',
  '$viewport_height',
  '$viewport_width',
  '$timezone',
  '$timezone_offset',
  '$host',
  '$pathname',
  '$current_url',
  '$referrer',
  '$referring_domain',
  '$session_entry_host',
  '$session_entry_pathname',
  '$session_entry_referring_domain',
  // This app's own.
  'product',
  'surface',
  'account_code',
  'embed',
  'page',
  'mode',
  'status',
  'preselected',
]);

/** Our own `utm_medium`, read off the clicked growth link, rides on this event only. */
const CTA_EVENT = 'calendars_cta_clicked';

/**
 * Campaign tags, per-click ids and a search engine's keyword, with the
 * vendor's `$initial_` and `$session_entry_` copies. A host's signup source is
 * the API's (claimed write-once from the first request), so the browser sends
 * none of its own.
 */
const CAMPAIGN_KEY = /^(\$initial_|\$session_entry_)?(utm_[a-z_]+|gclid|gclsrc|gad_source|dclid|gbraid|wbraid|fbclid|msclkid|twclid|li_fat_id|igshid|ttclid|rdt_cid|irclid|epik|qclid|sccid|mc_cid|oppref|_kx|ph_keyword|\$search_engine|search_engine)$/;

/**
 * A URL without its query string and fragment: `origin + path`, or the origin
 * alone. A query can carry anything a link builder put there (a prefilled
 * email, a token, a CRM's tracking ids), so none of it is sent.
 */
export function withoutQuery(value: unknown, keep: 'path' | 'origin'): unknown {
  if (typeof value !== 'string' || !value || value === '$direct') return value;
  try {
    const url = new URL(value);
    return keep === 'origin' ? url.origin : `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

/** Cut the query from every URL in a property bag, whatever the key. */
function scrubUrls(bag: Record<string, unknown>, surface: AnalyticsSurface): void {
  for (const [key, value] of Object.entries(bag)) {
    if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) continue;
    // Whoever linked to a booking page is somebody else; their path is none of ours.
    if (surface === 'visitor' && key.includes('referrer')) bag[key] = withoutQuery(value, 'origin');
    else if (/[?#]/.test(value)) bag[key] = withoutQuery(value, 'path');
  }
}

/**
 * The privacy filter every event passes through before it leaves the browser
 * (`before_send`). Returns null to drop the event.
 *
 *  - The host instance only speaks for dashboard pages. A host who follows a
 *    link from the dashboard to a booking page in the same tab would otherwise
 *    be reported there under their identity.
 *  - A visitor event keeps only `VISITOR_PROPERTIES` and carries no person
 *    properties at all. A host event drops every campaign tag and click id.
 *  - Every URL left, on either audience, loses its query and fragment.
 */
export function scrubEvent(event: CaptureEvent, surface: AnalyticsSurface, pathname: string): CaptureEvent | null {
  if (surface === 'host' && !HOST_PATH.test(pathname)) return null;
  if (surface === 'visitor') {
    const kept: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(event.properties ?? {})) {
      if (VISITOR_PROPERTIES.has(key) || (key === 'utm_medium' && event.event === CTA_EVENT)) kept[key] = value;
    }
    event.properties = kept;
    delete event.$set;
    delete event.$set_once;
  }
  for (const bag of [event.properties, event.$set, event.$set_once]) {
    if (!bag) continue;
    if (surface === 'host') for (const key of Object.keys(bag)) if (CAMPAIGN_KEY.test(key)) delete bag[key];
    scrubUrls(bag, surface);
  }
  return event;
}

/**
 * The vendor settings per audience. Everything that could record what a
 * person types or sees is OFF on both: no autocapture (an admin row's text is
 * an invitee's name), no session recording, no heatmaps, no surveys. Only the
 * events this app sends by hand are captured, plus dashboard pageviews.
 */
export function posthogSettings(
  config: AnalyticsConfig,
  surface: AnalyticsSurface,
  w: Pick<Window, 'location'>,
): Record<string, unknown> {
  const common = {
    api_host: config.host,
    autocapture: false,
    disable_session_recording: true,
    disable_surveys: true,
    disable_product_tours: true,
    disable_conversations: true,
    capture_heatmaps: false,
    capture_dead_clicks: false,
    rageclick: false,
    capture_exceptions: false,
    capture_performance: false,
    advanced_disable_flags: true,
    // The signup source is the API's, claimed write-once from the first
    // request; the browser collects no campaign tags of its own.
    save_campaign_params: false,
    mask_personal_data_properties: true,
    disable_capture_url_hashes: true,
    before_send: (event: CaptureEvent) => scrubEvent(event, surface, w.location.pathname),
  };
  if (surface === 'host') {
    return {
      ...common,
      person_profiles: 'identified_only',
      // The dashboard is a multi-route app: each navigation is a real page.
      capture_pageview: 'history_change',
      capture_pageleave: true,
    };
  }
  return {
    ...common,
    // No person profile, ever, and nothing written to the visitor's device:
    // the id lives in memory for the length of the visit and dies with it.
    person_profiles: 'never',
    persistence: 'memory',
    capture_pageview: false,
    capture_pageleave: false,
  };
}

/** Instances this page already initialized, so a remount never inits twice. */
const initialized = new Set<string>();

/** The methods the port calls, queued by the stub until the library loads. */
const QUEUED_METHODS = ['capture', 'identify', 'alias', 'register', 'group', 'reset'] as const;

/** Where the library is served from: the vendor's own hosts keep it on an assets host. */
function libraryOrigin(apiHost: string): string {
  return apiHost.replace('.i.posthog.com', '-assets.i.posthog.com');
}

/**
 * The vendor's loader contract, as module code rather than a pasted inline
 * script (so a strict Content-Security-Policy needs no `unsafe-inline` for it):
 * `window.posthog` is an array carrying `__SV` and an `_i` queue of
 * `[key, settings, name]` inits; each named instance is an array of
 * `[method, ...args]` calls (plus a `people` queue). When the library arrives
 * it initializes every queued instance and replays its calls, then replaces
 * the stub, keeping `__SV`.
 *
 * Once anything with an `init` lives at `window.posthog` (the stub, or the
 * library itself), it is used as it is: a second stub over the library would
 * replace its `init` and orphan every instance already running.
 */
function installStub(w: PosthogWindow, apiHost: string): PosthogGlobal {
  const existing = w.posthog;
  if (existing && typeof existing.init === 'function') return existing;
  const stub = [] as unknown as PosthogGlobal & { _i: unknown[][] };
  stub.__SV = 1;
  stub._i = [];
  stub.init = (key: string, config: Record<string, unknown>, name: string) => {
    const calls = [] as unknown as unknown[][] & Record<string, unknown>;
    calls['people'] = [];
    for (const method of QUEUED_METHODS) {
      calls[method] = (...args: unknown[]) => void calls.push([method, ...args]);
    }
    stub[name] = calls;
    stub._i.push([key, config, name]);
  };
  w.posthog = stub;
  // One request for the library, however many audiences queue an init.
  const script = w.document.createElement('script');
  script.async = true;
  script.crossOrigin = 'anonymous';
  script.src = `${libraryOrigin(apiHost)}/static/array.js`;
  w.document.head.appendChild(script);
  return stub;
}

/**
 * Start (or reuse) this audience's instance and return the port for it.
 */
export function connectPosthog(
  config: AnalyticsConfig,
  surface: AnalyticsSurface,
  w: PosthogWindow = window as PosthogWindow,
): AnalyticsPort {
  const global = installStub(w, config.host);
  const name = INSTANCE_NAME[surface];
  if (!initialized.has(name)) {
    global.init(config.key, posthogSettings(config, surface, w), name);
    initialized.add(name);
  }
  // Looked up on every call, never cached: the stub's queue for this name is
  // replaced by the real instance once the library has loaded.
  const instance = (): PosthogInstance | undefined => w.posthog?.[name] as PosthogInstance | undefined;
  const isHost = surface === 'host';
  return {
    surface,
    capture: (event, properties) => instance()?.capture(event, properties),
    identify: (distinctId, personProperties) => {
      if (isHost) instance()?.identify(distinctId, personProperties);
    },
    // The person is passed, never left to the current id: the library replays
    // queued `alias` calls BEFORE every other call when it loads, so on a
    // first page the current id would still be this browser's anonymous one.
    alias: (previousId, distinctId) => {
      if (isHost) instance()?.alias(previousId, distinctId);
    },
    register: (properties: AnalyticsProps) => instance()?.register(properties),
    group: (type, key, properties) => {
      if (isHost) instance()?.group(type, key, properties);
    },
    reset: () => instance()?.reset(),
  };
}

/** Test seam: forget which instances were initialized. */
export function resetPosthogForTests(): void {
  initialized.clear();
}
