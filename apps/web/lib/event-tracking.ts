import type { EventTracking } from '@slate/types';
import { installStub, type PosthogWindow } from '@/lib/analytics/posthog';

/**
 * The host's own tracking on ONE event's public booking page: Google Tag
 * Manager, Meta Pixel, a PostHog project of their own and HubSpot's tracking
 * code (`event_type.tracking`, set in the event editor). The same four tags
 * dForms loads per form, with the same rules:
 *
 *   - each loads only when its id is set; with none set the page makes no
 *     third-party request at all;
 *   - only on the event's booking page (personal, team, one-off link, embedded
 *     or not), never in the dashboard, the studio preview or the manage page;
 *   - one pageview per visit: the booking page is one document changing step,
 *     so a step is not a page.
 *
 * Unlike dForms' inline snippets, every tag is added from module code with the
 * id as data (a `src` query or a function argument), the way dCal already loads
 * its own PostHog: nothing is interpolated into an inline script, and a strict
 * Content-Security-Policy needs no `unsafe-inline` for any of it.
 *
 * None of this is dCal's own analytics (`lib/analytics/*`). Those count the
 * booking funnel anonymously for the product; these belong to the host and send
 * to the host's accounts.
 */

type Fbq = ((...args: unknown[]) => void) & {
  callMethod?: (...args: unknown[]) => void;
  queue?: unknown[];
  disablePushState?: boolean;
  push?: unknown;
  loaded?: boolean;
  version?: string;
};

export type TrackingWindow = Window & PosthogWindow & { dataLayer?: unknown[]; fbq?: Fbq; _fbq?: Fbq };

/** PostHog US cloud, the vendor's own default ingestion host. */
export const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';

/**
 * The name the host's PostHog instance runs under on the shared loader, apart
 * from dCal's `calendars_visitor`, so the two never share a queue or a config.
 */
export const EVENT_OWNER_POSTHOG = 'event_owner';

/**
 * The host's PostHog instance counts pageviews and nothing else. Autocapture,
 * session replay, heatmaps and surveys would follow the host project's own
 * settings, and on this page they would record what an invitee types (their
 * name and email) and the confirmation that shows it.
 */
const OWNER_POSTHOG_SETTINGS = {
  capture_pageview: false,
  capture_pageleave: false,
  autocapture: false,
  disable_session_recording: true,
  capture_heatmaps: false,
  capture_dead_clicks: false,
  rageclick: false,
  disable_surveys: true,
  capture_exceptions: false,
} as const;

/** The ids, resolved: trimmed, blank = off, the PostHog host defaulted. */
export interface ResolvedTracking {
  gtmId: string | null;
  metaPixelId: string | null;
  posthogKey: string | null;
  posthogHost: string;
  hubspotTrackingId: string | null;
}

function clean(value: string | null | undefined): string | null {
  const v = typeof value === 'string' ? value.trim() : '';
  return v ? v : null;
}

/**
 * Resolve an event's stored ids. There is no deployment-wide default, unlike
 * dForms' `NEXT_PUBLIC_*` fallbacks: on a shared deployment one id would collect
 * every host's booking pages into one account.
 */
export function resolveTracking(tracking: EventTracking | null | undefined): ResolvedTracking {
  return {
    gtmId: clean(tracking?.gtmId),
    metaPixelId: clean(tracking?.metaPixelId),
    posthogKey: clean(tracking?.posthogKey),
    posthogHost: clean(tracking?.posthogHost) ?? DEFAULT_POSTHOG_HOST,
    hubspotTrackingId: clean(tracking?.hubspotTrackingId),
  };
}

/** True when at least one tag would load (the page renders tracking at all). */
export function hasAnyTracking(t: ResolvedTracking): boolean {
  return Boolean(t.gtmId || t.metaPixelId || t.posthogKey || t.hubspotTrackingId);
}

export const gtmSrc = (id: string) => `https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(id)}`;
export const gtmNoscriptSrc = (id: string) => `https://www.googletagmanager.com/ns.html?id=${encodeURIComponent(id)}`;
export const META_PIXEL_SRC = 'https://connect.facebook.net/en_US/fbevents.js';
export const metaNoscriptSrc = (id: string) =>
  `https://www.facebook.com/tr?id=${encodeURIComponent(id)}&ev=PageView&noscript=1`;
export const hubspotSrc = (id: string) => `https://js.hs-scripts.com/${encodeURIComponent(id)}.js`;

function addScript(w: Window, src: string, attrs: Record<string, string> = {}): void {
  const script = w.document.createElement('script');
  script.async = true;
  script.src = src;
  for (const [name, value] of Object.entries(attrs)) script.setAttribute(name, value);
  w.document.head.appendChild(script);
}

/**
 * Ids each tag was already started with in this document, so a remount (a
 * client navigation, React's development double effect) never loads a tag or
 * counts a pageview twice.
 */
const started = new Set<string>();

/** Google Tag Manager: the container, behind the `gtm.js` event GTM expects first. */
export function loadGtm(w: TrackingWindow, id: string): void {
  if (started.has(`gtm:${id}`)) return;
  started.add(`gtm:${id}`);
  w.dataLayer = w.dataLayer || [];
  w.dataLayer.push({ 'gtm.start': Date.now(), event: 'gtm.js' });
  addScript(w, gtmSrc(id));
}

/**
 * Meta Pixel: the vendor's `fbq` queue, its library, `init` and ONE PageView.
 * An `fbq` already on the page is used as it is (Meta's own snippet does the
 * same), so a second id joins it instead of replacing it.
 */
export function loadMetaPixel(w: TrackingWindow, id: string): void {
  if (started.has(`meta:${id}`)) return;
  started.add(`meta:${id}`);
  if (!w.fbq) {
    const fbq: Fbq = function (...args: unknown[]) {
      if (fbq.callMethod) fbq.callMethod(...args);
      else fbq.queue!.push(args);
    };
    fbq.push = fbq;
    fbq.loaded = true;
    fbq.version = '2.0';
    fbq.queue = [];
    w.fbq = fbq;
    if (!w._fbq) w._fbq = fbq;
    addScript(w, META_PIXEL_SRC);
  }
  // One PageView per visit: the page's own history changes are steps, not pages.
  w.fbq.disablePushState = true;
  w.fbq('init', id);
  w.fbq('track', 'PageView');
}

/** HubSpot's tracking code. HubSpot expects the loader tag to carry this id. */
export function loadHubspot(w: TrackingWindow, id: string): void {
  if (started.has(`hubspot:${id}`) || w.document.getElementById('hs-script-loader')) return;
  started.add(`hubspot:${id}`);
  addScript(w, hubspotSrc(id), { id: 'hs-script-loader', defer: '' });
}

/**
 * The host's PostHog project, as the named instance {@link EVENT_OWNER_POSTHOG}
 * on the loader dCal's own analytics already uses (`installStub`): pageview
 * only, the automatic one off and exactly one captured by hand.
 *
 * The library comes from the vendor's own CDN whatever the host's ingestion
 * address is: whoever installs the shared loader first picks where the one
 * library loads from, and dCal's own instance must never run on a script a
 * host's (self-hosted, older) server sent. The host's address is only where
 * its events go.
 */
export function loadOwnerPosthog(w: TrackingWindow, key: string, host: string): void {
  if (started.has(`posthog:${key}`)) return;
  started.add(`posthog:${key}`);
  const posthog = installStub(w, DEFAULT_POSTHOG_HOST);
  posthog.init(key, { api_host: host, ...OWNER_POSTHOG_SETTINGS }, EVENT_OWNER_POSTHOG);
  const instance = w.posthog?.[EVENT_OWNER_POSTHOG] as { capture?: (event: string) => void } | undefined;
  instance?.capture?.('$pageview');
}

/** Start every tag the event has. Each one is wrapped: a failing vendor never breaks the page. */
export function startTracking(w: TrackingWindow, t: ResolvedTracking): void {
  const run = (start: () => void) => {
    try {
      start();
    } catch {
      /* a vendor that throws must not take the booking page with it */
    }
  };
  if (t.gtmId) run(() => loadGtm(w, t.gtmId!));
  if (t.metaPixelId) run(() => loadMetaPixel(w, t.metaPixelId!));
  if (t.posthogKey) run(() => loadOwnerPosthog(w, t.posthogKey!, t.posthogHost));
  if (t.hubspotTrackingId) run(() => loadHubspot(w, t.hubspotTrackingId!));
}

/** For tests only: forget which tags this document started. */
export function resetTrackingForTests(): void {
  started.clear();
}
