import type { AnalyticsConfig, AnalyticsProps } from '@slate/shared';
import type { AnalyticsPort, AnalyticsSurface } from './port';

/**
 * The PostHog adapter behind the browser analytics port.
 *
 * Zero dependencies: the vendor's documented loader stub (the same one Dapta
 * Forms ships) is installed by hand, and it loads the real library from the
 * configured host. That keeps `posthog-js` out of an open-source repo for a
 * feature that ships OFF, and it means a fork pays nothing, not even bundle
 * bytes, unless it turns analytics on.
 *
 * Each audience gets its own NAMED instance with its own settings, so a host
 * who opens their own booking page in the same tab is never reported as a
 * visitor with a name, and a visitor is never reported with the host's.
 */

/**
 * The vendor's loader stub, without its `init` call: it defines a queueing
 * `window.posthog` and loads `array.js` from the host given to `init`.
 */
const LOADER_STUB = `!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.crossOrigin="anonymous",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="init capture register register_once register_for_session unregister unregister_for_session getFeatureFlag getFeatureFlagPayload isFeatureEnabled reloadFeatureFlags updateEarlyAccessFeatureEnrollment getEarlyAccessFeatures on onFeatureFlags onSessionId getSurveys getActiveMatchingSurveys renderSurvey canRenderSurvey identify setPersonProperties group resetGroups setPersonPropertiesForFlags resetPersonPropertiesForFlags setGroupPropertiesForFlags resetGroupPropertiesForFlags reset get_distinct_id getGroups get_session_id get_session_replay_url alias set_config startSessionRecording stopSessionRecording sessionRecordingStarted captureException loadToolbar get_property getSessionProperty createPersonProfile opt_in_capturing opt_out_capturing has_opted_in_capturing has_opted_out_capturing clear_opt_in_out_capturing debug".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);`;

/** One PostHog instance (real, or the stub's queue standing in for it). */
interface PosthogInstance {
  capture(event: string, properties?: Record<string, unknown>): void;
  identify(distinctId: string, properties?: Record<string, unknown>): void;
  alias(alias: string): void;
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

/** Properties that hold a URL, wherever the vendor puts them. */
const URL_PROPERTIES = ['$current_url', '$referrer', '$initial_current_url', '$initial_referrer'] as const;

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

/**
 * The privacy filter every event passes through before it leaves the browser
 * (`before_send`). Returns null to drop the event.
 *
 *  - The host instance only speaks for dashboard pages. A host who follows a
 *    link from the dashboard to a booking page stays in the same tab, and the
 *    instance would otherwise report that page under their identity.
 *  - Every URL loses its query and fragment; a visitor's referrer is cut to
 *    its origin, since the page that linked to a booking page is somebody
 *    else's and its path is none of ours.
 */
export function scrubEvent(event: CaptureEvent, surface: AnalyticsSurface, pathname: string): CaptureEvent | null {
  if (surface === 'host' && !HOST_PATH.test(pathname)) return null;
  for (const bag of [event.properties, event.$set, event.$set_once]) {
    if (!bag) continue;
    for (const key of URL_PROPERTIES) {
      if (!(key in bag)) continue;
      const referrer = key === '$referrer' || key === '$initial_referrer';
      bag[key] = withoutQuery(bag[key], referrer && surface === 'visitor' ? 'origin' : 'path');
    }
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

function installStub(w: PosthogWindow): PosthogGlobal | null {
  if (!w.posthog?.__SV) {
    const script = w.document.createElement('script');
    script.textContent = LOADER_STUB;
    // Executes synchronously on insertion: the queue exists before the next line.
    w.document.head.appendChild(script);
  }
  return w.posthog ?? null;
}

/**
 * Start (or reuse) this audience's instance and return the port for it.
 * Returns null when the vendor global could not be installed.
 */
export function connectPosthog(
  config: AnalyticsConfig,
  surface: AnalyticsSurface,
  w: PosthogWindow = window as PosthogWindow,
): AnalyticsPort | null {
  const global = installStub(w);
  if (!global) return null;
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
    alias: (previousId) => {
      if (isHost) instance()?.alias(previousId);
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
