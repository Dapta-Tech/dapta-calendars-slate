import { analyticsEventName, type AnalyticsProps, type BrowserAnalyticsEvent } from '@slate/shared';

/**
 * The browser half of product analytics, as the app sees it: a PORT. Nothing
 * outside `lib/analytics/` names a vendor; components call `track()` and the
 * adapter the loader installed (PostHog today, `./posthog.ts`) does the rest.
 *
 * Two audiences, two ports, never mixed:
 *  - `host`: a signed-in host on the dashboard or the onboarding wizard.
 *    Identified by email, like the server half.
 *  - `visitor`: anyone on a public booking page. Never identified, never
 *    profiled: anonymous counts tied to the page's account by a property.
 */
export type AnalyticsSurface = 'host' | 'visitor';

export interface AnalyticsPort {
  readonly surface: AnalyticsSurface;
  capture(event: string, properties?: AnalyticsProps): void;
  /** Host only. A visitor port ignores it. */
  identify(distinctId: string, personProperties: AnalyticsProps): void;
  /**
   * Host only: join an earlier anonymous id (a landing visit) to the person
   * `distinctId`, named explicitly so the join never depends on what the
   * current id happens to be when the call runs.
   */
  alias(previousId: string, distinctId: string): void;
  /** Properties added to every later event on this port. */
  register(properties: AnalyticsProps): void;
  /** Host only: the account group every later event belongs to. */
  group(type: string, key: string, properties?: AnalyticsProps): void;
  /** Forget the identity (sign-out), so the next person is not filed as this one. */
  reset(): void;
}

/** Who is signed in, as the server resolved it. Nothing here comes from the URL. */
export interface HostAnalyticsIdentity {
  email: string;
  memberId: string;
  /** The account's immutable short code: the same group key the API uses. */
  accountKey: string;
  role: string;
  /** Decided on the server from the operator's patterns, which never reach the page. */
  isInternal: boolean;
  /** A marketing landing's anonymous id, parked by the middleware (`ph_id`). */
  landingId: string | null;
}

let active: AnalyticsPort | null = null;

/** Installed by the loader component on mount. */
export function setActiveAnalyticsPort(port: AnalyticsPort | null): void {
  active = port;
}

/** Cleared by the loader on unmount, only if it is still the active one. */
export function clearActiveAnalyticsPort(port: AnalyticsPort): void {
  if (active === port) active = null;
}

/**
 * Record one browser event. The `calendars_` prefix is added here, never at a
 * call site. A no-op when analytics is off (no port was ever installed), and it
 * never throws: telemetry must not be able to break a click.
 */
export function track(event: BrowserAnalyticsEvent, properties?: AnalyticsProps): void {
  try {
    active?.capture(analyticsEventName(event), properties);
  } catch {
    /* never into a user path */
  }
}

/**
 * Drop the host identity. Run on sign-out: without it the next person to use
 * this browser inherits the previous host's id and their activity is filed
 * under someone else.
 */
export function resetAnalytics(): void {
  try {
    if (active?.surface === 'host') active.reset();
  } catch {
    /* never into a user path */
  }
}
