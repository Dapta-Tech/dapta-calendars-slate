import 'server-only';
import {
  createErrorReporter,
  exceptionEvent,
  hostOfUrl,
  reportableHost,
  reportableRequestId,
  sendAnalyticsEvent,
  type AnalyticsConfig,
  type AnalyticsProps,
  type ErrorReport,
  type ErrorReporter,
} from '@slate/shared';
import { analyticsConfig } from './config';

/**
 * Error tracking, the web server's half: every error Next reports through
 * `onRequestError` (a failed render, route handler, server action or
 * middleware) sent to the analytics provider's error tracking, scrubbed, from
 * the same bounded, rate-limited, de-duplicating reporter the API uses
 * (`createErrorReporter`, `@slate/shared`).
 *
 * Off unless analytics is on and `PRODUCT_ANALYTICS_ERRORS` is not `off`,
 * read from the runtime env like the rest of analytics, so one image serves
 * every environment.
 *
 * What a report says about the request: the route TEMPLATE
 * (`/[accountCode]/[handle]/[slug]`), the method, 500, the request id, what
 * kind of work failed (render, route, action, proxy), the error's digest (the
 * id the browser's error boundary shows, so the two can be matched), and as
 * `$host` the public host the request was addressed to (its Host header, when
 * that is a public name; else the deployment's `PUBLIC_APP_URL`). The path
 * itself, its query, the body and every other header are never sent.
 */

/** Who a web server error is filed under: the process, never a person. */
export const WEB_SERVER_ERROR_DISTINCT_ID = 'calendars-web-server';

/** The parts of Next's `onRequestError` request this reads. */
export interface FailedRequest {
  path: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
}

/** The parts of Next's `onRequestError` context this reads. */
export interface FailedRequestContext {
  routePath: string;
  routeType: string;
  renderSource?: string;
}

/** The one place the web server picks a vendor for errors. A fork adds one here. */
function deliveryFor(config: AnalyticsConfig): ((report: ErrorReport) => Promise<void>) | null {
  switch (config.provider) {
    case 'posthog':
      return async (report) => {
        await sendAnalyticsEvent(config, exceptionEvent(report, { distinctId: WEB_SERVER_ERROR_DISTINCT_ID }));
      };
    default:
      return null;
  }
}

let reporter: ErrorReporter | null | undefined;

/** This process's reporter, built on first use from the runtime env; null when error tracking is off. */
export function webServerErrorReporter(env: NodeJS.ProcessEnv = process.env): ErrorReporter | null {
  if (reporter !== undefined) return reporter;
  const config = analyticsConfig(env);
  const deliver = config?.errors ? deliveryFor(config) : null;
  const host = hostOfUrl(env.PUBLIC_APP_URL);
  reporter = deliver
    ? createErrorReporter({
        deliver,
        properties: { surface: 'next_server', ...(host ? { $host: host } : {}) },
        root: typeof process.cwd === 'function' ? process.cwd() : undefined,
      })
    : null;
  return reporter;
}

/**
 * Next can report one failure twice (the server components pass, then the
 * HTML pass that rendered its digest): one report per digest a minute.
 */
const recentDigests = new Map<string, number>();
const DIGEST_WINDOW_MS = 60_000;

function seenRecently(digest: string, now: number): boolean {
  for (const [d, at] of recentDigests) {
    if (now - at < DIGEST_WINDOW_MS && recentDigests.size <= 500) break;
    recentDigests.delete(d);
  }
  if (recentDigests.has(digest)) return true;
  recentDigests.set(digest, now);
  return false;
}

/** The account a public route was serving, from its first path segment: never the rest of the path. */
function accountCodeOf(context: FailedRequestContext, request: FailedRequest): string | undefined {
  if (!context.routePath.startsWith('/[accountCode]')) return undefined;
  const segment = request.path.split(/[?#]/)[0]?.split('/')[1];
  return segment && /^[A-Za-z0-9_-]{1,64}$/.test(segment) ? segment : undefined;
}

/**
 * Report one failed request. Returns at once (the report is sent off the
 * request path) and never throws: a broken reporter must not turn one error
 * into two.
 */
export function reportRequestError(
  error: unknown,
  request: FailedRequest,
  context: FailedRequestContext,
  env: NodeJS.ProcessEnv = process.env,
): void {
  try {
    const r = webServerErrorReporter(env);
    if (!r) return;
    const digest =
      typeof error === 'object' && error !== null && typeof (error as { digest?: unknown }).digest === 'string'
        ? (error as { digest: string }).digest
        : undefined;
    if (digest && seenRecently(digest, Date.now())) return;
    const account = accountCodeOf(context, request);
    const host = reportableHost(request.headers['host']);
    const properties: AnalyticsProps = {
      ...(host ? { $host: host } : {}),
      route: context.routePath,
      method: request.method,
      status: 500,
      request_id: reportableRequestId(request.headers['x-request-id']),
      route_type: context.routeType,
      ...(context.renderSource ? { render_source: context.renderSource } : {}),
      ...(digest ? { digest } : {}),
      ...(account ? { account_code: account } : {}),
    };
    r.report(error, { handled: false, mechanism: 'on_request_error', properties });
  } catch {
    /* never into a request */
  }
}

/** Test seam: forget the reporter and the digests seen. */
export function resetWebServerErrorsForTests(): void {
  reporter = undefined;
  recentDigests.clear();
}
