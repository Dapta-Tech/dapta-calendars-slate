import 'server-only';
import { randomUUID } from 'node:crypto';
import { after } from 'next/server';
import {
  ANALYTICS_PRODUCT,
  analyticsCampaignValue,
  analyticsEventName,
  hostOfUrl,
  sanitizeLandingDistinctId,
  sendAnalyticsEvent,
  type AnalyticsFetch,
  type AnalyticsProps,
} from '@slate/shared';
import { analyticsConfig } from './config';

/**
 * `calendars_login_started`: the login route sent someone to the hosted
 * sign-in or sign-up screen.
 *
 * The one funnel step no page can record. The root and `/login` redirect to
 * the login route before any page loads the browser library, and the route
 * redirects again to the identity provider, so a person who opens the hosted
 * screen and gives up there left no event at all: drop-off on that screen could
 * not be measured. The route records the start itself, on the server.
 *
 * Never on the login's clock. The event is sent with Next's `after`, once the
 * redirect has gone out, within the shared 3 second request timeout, and any
 * failure is logged and dropped: analytics observes the login and must never
 * slow it or fail it.
 *
 * Who it is about:
 *  - With a landing's anonymous id parked (`slate.ph_id`, see the middleware),
 *    the event is filed under that id, the one the landing's own events carry.
 *    The first dashboard page aliases it onto the host's email, so "visited the
 *    landing, started a sign-up, signed up" is one person.
 *  - Without one, under a random id with no person profile: a count of starts
 *    that never mints a person.
 *
 * What it carries: `screen` (`sign-up` or `sign-in`), `has_ph_id`, the parked
 * `utm_source` when it is a plain campaign label (`analyticsCampaignValue`, the
 * same rule as `attribution_captured`), `product` and `$host`. Nothing about
 * the person, no URL, no query string. `$geoip_disable` because the request
 * comes from this server, whose address says nothing about where the person is.
 */

/** Which hosted screen the login opens on. */
export type LoginScreen = 'sign-up' | 'sign-in';

/** What the login route knows about one login start. Raw values, checked here. */
export interface LoginStart {
  screen: LoginScreen;
  /** The `slate.ph_id` cookie as it arrived, unchecked. */
  landingCookie: string | undefined;
  /** The `slate.attribution` cookie as it arrived, unchecked. */
  attributionCookie: string | undefined;
  /** This request's public origin (`requestOrigin`). */
  origin: string;
  /** The `user-agent` header. */
  userAgent: string | null;
}

/**
 * Clients that are not a person opening a login: crawlers and link previewers
 * follow the root's redirect too (WhatsApp's and Viber's fetchers name only
 * the app, hence the anchored entries), and every one would be a start that can
 * never finish. The browser library drops these on its own; a server event has
 * to do it here.
 */
const AUTOMATED_AGENT =
  /^whatsapp\/|^viber|bot\b|bot\/|crawl|spider|slurp|preview|headless|lighthouse|facebookexternalhit|embedly|curl\/|wget\/|python-|go-http-client|okhttp|axios\/|node-fetch|undici/i;

/** The parked campaign source, or null when there is none or it is not a plain label. */
function parkedUtmSource(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const parked = JSON.parse(raw) as { utm_source?: unknown } | null;
    return analyticsCampaignValue(parked?.utm_source);
  } catch {
    return null;
  }
}

/**
 * The capture body for one login start, or null when it is not worth sending
 * (no user agent, or an automated one). Pure, apart from the random id.
 */
export function loginStartedEvent(
  start: LoginStart,
  newId: () => string = randomUUID,
): Record<string, unknown> | null {
  if (!start.userAgent || AUTOMATED_AGENT.test(start.userAgent)) return null;
  const landingId = sanitizeLandingDistinctId(start.landingCookie);
  const utmSource = parkedUtmSource(start.attributionCookie);
  const host = hostOfUrl(start.origin);
  const properties: AnalyticsProps = {
    product: ANALYTICS_PRODUCT,
    screen: start.screen,
    has_ph_id: landingId !== null,
    ...(utmSource ? { utm_source: utmSource } : {}),
    ...(host ? { $host: host } : {}),
    $geoip_disable: true,
    // Personless without a landing id: a random id must never become a person.
    ...(landingId ? {} : { $process_person_profile: false }),
  };
  return {
    event: analyticsEventName('login_started'),
    distinct_id: landingId ?? `calendars-login-${newId()}`,
    properties,
  };
}

/**
 * Send one login start. Never throws: every failure, a refused key included,
 * is one warning in the log and nothing else.
 */
export async function recordLoginStarted(
  start: LoginStart,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: AnalyticsFetch,
): Promise<void> {
  try {
    const config = analyticsConfig(env);
    if (config?.provider !== 'posthog') return;
    const body = loginStartedEvent(start);
    if (!body) return;
    const res = await sendAnalyticsEvent(config, body, fetchImpl);
    if (!res.ok) console.warn(`calendars_login_started was not delivered: HTTP ${res.status}`);
  } catch (error) {
    console.warn(
      `calendars_login_started was not delivered: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Record a login start after the response has been sent. Outside a request
 * (a script, a spec that does not stub `after`) `after` throws, and there is
 * then nothing to record.
 */
export function scheduleLoginStarted(start: LoginStart): void {
  try {
    after(() => recordLoginStarted(start));
  } catch {
    /* not in a request: nothing to record */
  }
}
