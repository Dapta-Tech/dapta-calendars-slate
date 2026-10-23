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
 * that is a public name; else the deployment's `PUBLIC_APP_URL`). The request
 * path, its query, the body and every other header are never sent. The
 * error's own message is, scrubbed: it can name an API path the server called,
 * such as `/v1/profiles/{account}/{handle}`, the same public segments as the
 * booking page's own address.
 *
 * Repeats of one failure (the same type, message and failing line) are
 * counted by the reporter, not dropped: the first is sent at once, and one
 * more event a minute later carries how many followed (`count`).
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
        const res = await sendAnalyticsEvent(config, exceptionEvent(report, { distinctId: WEB_SERVER_ERROR_DISTINCT_ID }));
        if (!res.ok) throw new Error(`error tracking refused the event: HTTP ${res.status}`);
      };
    default:
      return null;
  }
}

/**
 * The stack Next would print for an error. Next replaces the runtime's stack
 * formatter, so `error.stack` names lines of the bundled server chunks; what
 * Next prints (`util.inspect`) has the build's source maps applied, so frames
 * name `lib/api.ts:81`. Only the error's own frames are kept: what Next adds
 * after them (its properties, a cause) is cut. Unavailable outside Node (the
 * edge runtime), where the plain stack stands.
 */
function nextStack(error: Error): string | undefined {
  const util = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process?.getBuiltinModule?.(
    'node:util',
  ) as { inspect?: (value: unknown, options: Record<string, unknown>) => string } | undefined;
  if (!util?.inspect) return undefined;
  const lines: string[] = [];
  let inFrames = false;
  for (const raw of util.inspect(error, { colors: false, depth: 0 }).split('\n')) {
    const line = raw.replace(/ \{$/, '');
    const frame = /^\s+at /.test(line);
    if (inFrames && !frame) break;
    inFrames ||= frame;
    lines.push(line);
  }
  return lines.join('\n');
}

let reporter: ErrorReporter | null | undefined;

/**
 * Drops and failed deliveries (a refused key) are said in the log, each at
 * most once a minute, on clocks of their own so one never hides the other.
 */
const lastWarning = { drop: 0, failure: 0 };
function warnAtMostOnceAMinute(kind: keyof typeof lastWarning, message: string): void {
  const now = Date.now();
  if (now - lastWarning[kind] < 60_000) return;
  lastWarning[kind] = now;
  console.warn(message);
}

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
        stackOf: nextStack,
        onDrop: (reason) =>
          warnAtMostOnceAMinute('drop', `error reports are being dropped (${reason}); the log still has every error`),
        onFailure: (error) =>
          warnAtMostOnceAMinute(
            'failure',
            `error reports are not being delivered: ${error instanceof Error ? error.message : String(error)}`,
          ),
      })
    : null;
  return reporter;
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

/** Test seam: forget the reporter. */
export function resetWebServerErrorsForTests(): void {
  reporter = undefined;
  lastWarning.drop = 0;
  lastWarning.failure = 0;
}
