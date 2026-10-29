import {
  ANALYTICS_PRODUCT,
  scrubErrorText,
  scrubFrameFilename,
  type AnalyticsConfig,
  type AnalyticsProps,
} from '@slate/shared';
import { HOST_PATH, analyticsSurfaceOf, type AnalyticsPort, type AnalyticsSurface } from './port';

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
  captureException(error: unknown, properties?: Record<string, unknown>): void;
}

export interface PosthogGlobal {
  __SV?: number;
  init(key: string, config: Record<string, unknown>, name: string): unknown;
  [instance: string]: unknown;
}

export type PosthogWindow = Window & { posthog?: PosthogGlobal };

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
  // An error (`$exception`), after `scrubException`: the scrubbed exception
  // list and its level, the release the build was stamped with (for stack
  // symbolication), and which boundary caught it.
  '$exception_list',
  '$exception_level',
  '$release_id',
  'error_boundary',
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

/** What an error's exception entry, mechanism and stack frame may carry, and nothing else. */
const MECHANISM_KEYS = ['type', 'handled', 'synthetic', 'exception_id', 'parent_id', 'source'] as const;
const FRAME_KEYS = ['platform', 'lineno', 'colno', 'in_app', 'chunk_id'] as const;
/** The most exceptions (an error and its causes) and frames per exception sent. */
const MAX_EXCEPTIONS = 5;
const MAX_FRAMES = 50;

/** Copy only the named keys, and only when their value is a primitive. */
function pick(source: unknown, keys: readonly string[]): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!source || typeof source !== 'object') return out;
  for (const key of keys) {
    const value = (source as Record<string, unknown>)[key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') out[key] = value;
  }
  return out;
}

/**
 * An `$exception` event's own properties, made fit to leave: every message
 * and type through `scrubErrorText` (emails, phones, digit runs, tokens and
 * query strings out), every frame's file without its query, and only the
 * named fields of each exception, mechanism and frame kept, so a vendor
 * release that starts attaching source lines or variables attaches them to
 * nothing. Breadcrumbs (`$exception_steps`) and every older single-exception
 * field are dropped: this app records none it would want sent.
 */
function scrubException(bag: Record<string, unknown>): void {
  const list = Array.isArray(bag['$exception_list']) ? (bag['$exception_list'] as unknown[]) : [];
  bag['$exception_list'] = list.slice(0, MAX_EXCEPTIONS).map((raw) => {
    const entry = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const trace = (entry['stacktrace'] && typeof entry['stacktrace'] === 'object' ? entry['stacktrace'] : {}) as Record<
      string,
      unknown
    >;
    const frames = Array.isArray(trace['frames']) ? (trace['frames'] as unknown[]) : [];
    return {
      type: scrubErrorText(entry['type']) || 'Error',
      value: scrubErrorText(entry['value']),
      mechanism: pick(entry['mechanism'], MECHANISM_KEYS),
      stacktrace: {
        type: typeof trace['type'] === 'string' ? trace['type'] : 'raw',
        frames: frames.slice(-MAX_FRAMES).map((frame) => {
          const raw = (frame && typeof frame === 'object' ? frame : {}) as Record<string, unknown>;
          const filename = scrubFrameFilename(raw['filename']);
          const fn = typeof raw['function'] === 'string' ? scrubErrorText(raw['function']).slice(0, 200) : '';
          return { ...pick(raw, FRAME_KEYS), ...(filename ? { filename } : {}), ...(fn ? { function: fn } : {}) };
        }),
      },
    };
  });
  for (const key of Object.keys(bag)) {
    if (key.startsWith('$exception_') && key !== '$exception_list' && key !== '$exception_level') {
      delete bag[key];
    }
  }
}

/** Our own `utm_medium`, read off the clicked growth link, rides on this event only. */
const CTA_EVENT = 'calendars_cta_clicked';

/**
 * Campaign tags, per-click ids and a search engine's keyword, with the
 * vendor's `$initial_` and `$session_entry_` copies. A host's signup source is
 * the API's (claimed write-once from the first request), so the browser sends
 * none of its own. The list is wider than what the pinned library collects
 * today (`bfcid` is not in it yet), so a release that adds one is covered.
 */
const CAMPAIGN_KEY = /^(\$initial_|\$session_entry_)?(utm_[a-z_]+|gclid|gclsrc|gad_source|dclid|gbraid|wbraid|bfcid|fbclid|msclkid|twclid|li_fat_id|igshid|ttclid|rdt_cid|irclid|epik|qclid|sccid|mc_cid|oppref|_kx|ph_keyword|\$search_engine|search_engine)$/;

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
 *  - An error (`$exception`) is scrubbed (`scrubException`) on both
 *    audiences, tagged with the product and its surface (`browser_host`,
 *    `browser_visitor`), and a visitor's only leaves from a booking page.
 *  - A visitor event keeps only `VISITOR_PROPERTIES` and carries no person
 *    properties at all. A host event drops every campaign tag and click id.
 *  - Every URL left, on either audience, loses its query and fragment.
 */
export function scrubEvent(event: CaptureEvent, surface: AnalyticsSurface, pathname: string): CaptureEvent | null {
  if (surface === 'host' && !HOST_PATH.test(pathname)) return null;
  if (event.event === '$exception') {
    // The visitor's error capture listens to the whole tab and outlives its
    // page: it reports from booking pages only, never from a host's dashboard
    // or a manage link the same tab moved on to.
    if (surface === 'visitor' && analyticsSurfaceOf(pathname) !== 'visitor') return null;
    event.properties = event.properties ?? {};
    scrubException(event.properties);
    // Every error says which product and which surface it came from, also
    // one captured before (or without) a loader registering anything. The
    // vendor sets `$host` (the page's host) itself.
    event.properties['product'] = ANALYTICS_PRODUCT;
    event.properties['surface'] = surface === 'host' ? 'browser_host' : 'browser_visitor';
  }
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
 * Error capture, when error tracking is on: what nothing caught (an uncaught
 * error, an unhandled rejection), on both audiences. Never the console: a
 * logged line can be anything the code that logged it was holding.
 *
 * On a booking page too, on purpose: the booking flow fails in event handlers
 * and async calls (a slot that will not load, a submit that throws), which no
 * error boundary ever sees, so explicit reports alone would miss the failures
 * that cost a booking. What leaves is the same allowlisted, scrubbed,
 * anonymous event as any other visitor event.
 */
const EXCEPTION_CAPTURE = {
  capture_unhandled_errors: true,
  capture_unhandled_rejections: true,
  capture_console_errors: false,
};

/**
 * The vendor settings per audience. Everything that could record what a
 * person types or sees is OFF on both: no autocapture (an admin row's text is
 * an invitee's name), no session recording, no heatmaps, no surveys. Only the
 * events this app sends by hand are captured, plus dashboard pageviews and,
 * with error tracking on, uncaught errors.
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
    capture_exceptions: config.errors ? EXCEPTION_CAPTURE : false,
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
const QUEUED_METHODS = ['capture', 'identify', 'alias', 'register', 'group', 'reset', 'captureException'] as const;

/**
 * The posthog-js release every page loads, pinned: the host's own PostHog
 * instance on a booking page relies on this release's switches to load nothing
 * from the project (`OWNER_POSTHOG_SETTINGS` in `lib/event-tracking.ts`), so a
 * new release is taken on purpose, after checking them again, never because the
 * CDN moved.
 */
export const POSTHOG_JS_VERSION = '1.441.0';

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
 *
 * Exported for the event's own PostHog project (`lib/event-tracking.ts`), which
 * must ride this same loader as a named instance: the vendor's pasted snippet
 * calls `init` without a name, and on this stub that would break every
 * instance on the page.
 */
export function installStub(w: PosthogWindow, apiHost: string): PosthogGlobal {
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
  script.src = `${libraryOrigin(apiHost)}/static/${POSTHOG_JS_VERSION}/array.js`;
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
    captureError: (error, properties) => {
      if (config.errors) instance()?.captureException(error, properties);
    },
  };
}

/** Test seam: forget which instances were initialized. */
export function resetPosthogForTests(): void {
  initialized.clear();
}
