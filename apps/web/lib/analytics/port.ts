import {
  ANALYTICS_PRODUCT,
  analyticsEventName,
  type AnalyticsConfig,
  type AnalyticsProps,
  type BrowserAnalyticsEvent,
} from '@slate/shared';

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
  /**
   * Report an error this app caught (an error boundary). The adapter scrubs
   * it before it leaves (`scrubErrorText`), and sends nothing when error
   * tracking is off (`config.errors`).
   */
  captureError(error: unknown, properties?: AnalyticsProps): void;
}

/** The dashboard and the first-run wizard: the only pages a host is reported from. */
export const HOST_PATH = /^\/(admin|onboarding)(\/|$)/;

/**
 * Not a booking page: the product's own routes, the manage page and one-off
 * links (both carry a token in their URL), and the framework's assets.
 */
const NOT_A_BOOKING_PAGE = /^\/(admin|onboarding|login|auth|api|manage|booking|_next)(\/|$)/;

/**
 * Which audience a page belongs to, from its path alone: `host` on the
 * dashboard and wizard, `visitor` on a public booking page
 * (`/{account}/{handle}[/{slug}]`, `/{account}/team/{team}[/{slug}]`), and
 * none anywhere else, where nothing is reported from the browser at all.
 */
export function analyticsSurfaceOf(pathname: string): AnalyticsSurface | null {
  if (HOST_PATH.test(pathname)) return 'host';
  if (!NOT_A_BOOKING_PAGE.test(pathname) && /^\/[^/]+\/[^/]+/.test(pathname)) return 'visitor';
  return null;
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

/**
 * Every audience connected on this page, kept after its loader unmounts: the
 * vendor's instance outlives the component, and an error boundary that
 * replaced a page (and its loader) still reports through it.
 */
const connected = new Map<AnalyticsSurface, AnalyticsPort>();

/** The deployment's settings, for a boundary that has to connect an audience itself. Null = errors off. */
let errorConfig: AnalyticsConfig | null = null;

/** Installed by the loader component on mount. */
export function setActiveAnalyticsPort(port: AnalyticsPort | null): void {
  active = port;
  if (port) connected.set(port.surface, port);
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

/** Where an error was caught: which `error.tsx` (or `global-error.tsx`). */
export type ErrorBoundaryName = 'root' | 'dashboard' | 'booking_page' | 'global';

/** Handed down by the root layout (`ErrorAnalytics`). Null, or errors off, turns browser error reports off. */
export function setErrorAnalyticsConfig(config: AnalyticsConfig | null): void {
  errorConfig = config?.errors ? config : null;
}

/**
 * Errors from the server arrive with a `digest`; the web server already
 * reported them with the real message and stack (`instrumentation.ts`), and
 * the copy the browser holds is a generic stand-in. Sent again, every server
 * failure would collapse into one browser issue named after that stand-in.
 */
function reportedByServer(error: unknown): boolean {
  return typeof error === 'object' && error !== null && typeof (error as { digest?: unknown }).digest === 'string';
}

/** One report per error object, however many times a boundary's effect runs. */
const reported = new WeakSet<object>();

/**
 * Report an error an error boundary caught. Never throws, never blocks the
 * boundary's render, and sends nothing:
 *  - with error tracking off (no config, or `PRODUCT_ANALYTICS_ERRORS=off`);
 *  - on a page that belongs to no audience (login, manage, one-off links);
 *  - for an error the server already reported (it has a `digest`).
 *
 * The audience's own instance is used when the page connected one; when the
 * page failed before its loader could (a render error on the first paint),
 * the audience is connected here, from a chunk only an error ever loads.
 */
export function captureError(error: unknown, boundary: ErrorBoundaryName): void {
  try {
    if (reportedByServer(error)) return;
    if (typeof error === 'object' && error !== null) {
      if (reported.has(error)) return;
      reported.add(error);
    }
    const surface = analyticsSurfaceOf(window.location.pathname);
    if (!surface) return;
    // The adapter adds the surface the error came from (`browser_host`, `browser_visitor`).
    const properties: AnalyticsProps = { product: ANALYTICS_PRODUCT, error_boundary: boundary };
    const known = connected.get(surface);
    if (known) return known.captureError(error, properties);
    const config = errorConfig;
    if (!config) return;
    void import('./connect')
      .then(({ connectAnalytics }) => {
        const port = connected.get(surface) ?? connectAnalytics(config, surface);
        if (!port) return;
        connected.set(surface, port);
        port.captureError(error, properties);
      })
      .catch(() => undefined);
  } catch {
    /* never into a user path */
  }
}

/** Test seam: forget every connected audience and the error settings. */
export function resetAnalyticsPortsForTests(): void {
  active = null;
  connected.clear();
  errorConfig = null;
}
