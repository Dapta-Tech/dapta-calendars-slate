import { Catch, HttpException, Inject, Logger, Optional, type ArgumentsHost } from '@nestjs/common';
import { BaseExceptionFilter, HttpAdapterHost } from '@nestjs/core';
import type { ServerEnv } from '@slate/config/env';
import {
  analyticsErrorsEnabled,
  createErrorReporter,
  hostOfUrl,
  type ErrorReporter,
  type ErrorReporterOptions,
} from '@slate/shared';
import type { AnalyticsProvider } from './analytics.provider';
import { requestErrorContext, requestIdFrom } from './request-log';
import { ERROR_REPORTER } from './tokens';

/**
 * Error tracking, the API half: every 5xx and every crash reported to the
 * analytics provider's error tracking, through the same port as product
 * analytics (`AnalyticsProvider.captureException`).
 *
 * Off unless analytics is on and `PRODUCT_ANALYTICS_ERRORS` is not `off`:
 * then there is no reporter (`null`), the filter only answers as Nest's own
 * would, and no process hook is installed, so a bare fork behaves exactly as
 * it did before this file existed.
 *
 * What is an error here: a response of 500 or more, and anything thrown that
 * is not an `HttpException` (Nest answers those 500). A handled 4xx
 * (validation, auth, rate limit, not found) is the API working, not failing,
 * and is never reported.
 *
 * Never through the outbox: a report waits in memory (`createErrorReporter`,
 * at most 100, at most 60 sent a minute, the same error counted once a minute),
 * so a database outage is reported rather than lost with the database. Sent
 * off the request path, so a slow provider never slows an answer.
 */

/** The request's own context plus the status, for one failed request. */
export interface RequestErrorOptions {
  /** The status the response carries, when the caller decided it (the v2 filter). */
  status?: number;
  /** The request id the caller was given, when it was not read from the header. */
  requestId?: string;
}

/** The status a thrown value answers with: its own for an `HttpException`, else 500. */
export function statusOf(exception: unknown): number {
  return exception instanceof HttpException ? exception.getStatus() : 500;
}

/** How often a shedding reporter says so in the log. */
const DROP_WARNING_EVERY_MS = 60_000;

/**
 * The API's error reporter, or null when error tracking is off (analytics
 * off, `PRODUCT_ANALYTICS_ERRORS=off`, or a provider without `captureException`).
 */
export function createApiErrorReporter(
  env: Pick<ServerEnv, 'PRODUCT_ANALYTICS_ERRORS' | 'PUBLIC_APP_URL' | 'API_PUBLIC_URL'>,
  provider: AnalyticsProvider | null,
  overrides: Partial<ErrorReporterOptions> = {},
): ErrorReporter | null {
  const capture = provider?.captureException?.bind(provider);
  if (!capture || !analyticsErrorsEnabled(env.PRODUCT_ANALYTICS_ERRORS)) return null;
  // `$host` names the public address the error belongs to, from configuration
  // only: the public API host, else the deployment's public app host. Never a
  // request's Host header: the web server calls this API at its internal
  // address, which is not a name anyone outside can use.
  const host = hostOfUrl(env.API_PUBLIC_URL) ?? hostOfUrl(env.PUBLIC_APP_URL);
  const log = new Logger('ErrorTracking');
  // One clock per kind: a flood of drops must not hide that delivery fails.
  const lastWarning = { drop: 0, failure: 0 };
  const warnAtMostOnceAMinute = (kind: keyof typeof lastWarning, message: string) => {
    const now = Date.now();
    if (now - lastWarning[kind] < DROP_WARNING_EVERY_MS) return;
    lastWarning[kind] = now;
    log.warn(message);
  };
  return createErrorReporter({
    deliver: capture,
    properties: { surface: 'api', ...(host ? { $host: host } : {}) },
    root: process.cwd(),
    onDrop: (reason) =>
      warnAtMostOnceAMinute('drop', `error reports are being dropped (${reason}); the log still has every error`),
    onFailure: (error) =>
      warnAtMostOnceAMinute(
        'failure',
        `error reports are not being delivered: ${error instanceof Error ? error.message : String(error)}`,
      ),
    ...overrides,
  });
}

/**
 * Report one failed request, if it failed: a 5xx or anything that is not an
 * `HttpException`. Never throws.
 */
export function reportRequestError(
  reporter: ErrorReporter | null | undefined,
  exception: unknown,
  req: unknown,
  opts: RequestErrorOptions = {},
): void {
  if (!reporter) return;
  try {
    const status = opts.status ?? statusOf(exception);
    if (status < 500) return;
    reporter.report(exception, {
      handled: false,
      mechanism: 'filter',
      properties: { ...requestErrorContext(req, opts.requestId), status },
    });
  } catch {
    /* reporting never changes the answer */
  }
}

/**
 * The global exception filter: reports a failed request, then answers
 * exactly as Nest's default would (`BaseExceptionFilter`), same status, same
 * body, same log line. A controller with its own filter (the v2 surface)
 * reports from there instead, since Nest runs only the nearest one.
 */
@Catch()
export class ErrorReportingFilter extends BaseExceptionFilter {
  constructor(
    // Explicit tokens: the API runs on tsx, which emits no decorator metadata.
    @Inject(HttpAdapterHost) adapterHost: HttpAdapterHost,
    @Optional() @Inject(ERROR_REPORTER) private readonly reporter: ErrorReporter | null = null,
  ) {
    super(adapterHost.httpAdapter);
  }

  override catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() === 'http' && this.reporter) {
      const http = host.switchToHttp();
      const req = http.getRequest<{ headers?: Record<string, string | string[] | undefined> }>();
      const res = http.getResponse<{ headersSent?: boolean; getHeader?(n: string): unknown; setHeader?(n: string, v: string): void }>();
      // The request log names every request; with it off, a reported failure
      // still tells the client the id its report carries. An id a handler
      // already gave the response (the MCP endpoint does) is the one used.
      const given = res?.getHeader?.('X-Request-Id');
      const requestId = typeof given === 'string' && given ? given : requestIdFrom(req?.headers?.['x-request-id']);
      if (statusOf(exception) >= 500 && res && !res.headersSent && !given) {
        res.setHeader?.('X-Request-Id', requestId);
      }
      reportRequestError(this.reporter, exception, req, { requestId });
    }
    super.catch(exception, host);
  }
}

/** What the process hooks need, injectable so a test never touches the real process. */
export interface ProcessHookOptions {
  proc?: Pick<NodeJS.Process, 'on' | 'off'>;
  exit?: (code: number) => void;
  /** How long a crash waits for its own report to leave. */
  flushMs?: number;
  /** Node's `--unhandled-rejections` mode; read from the process when not given. */
  unhandledRejections?: string;
  log?: (message: string, error: unknown) => void;
}

/**
 * Node's `--unhandled-rejections` mode, from `NODE_OPTIONS` and the process's
 * own flags, read in Node's order: the command line overrides `NODE_OPTIONS`.
 */
export function unhandledRejectionsMode(
  execArgv: readonly string[] = process.execArgv,
  nodeOptions: string | undefined = process.env['NODE_OPTIONS'],
): string {
  const flags = [...(nodeOptions ?? '').split(/\s+/), ...execArgv];
  let mode = 'throw';
  flags.forEach((flag, i) => {
    const m = /^--unhandled-rejections(?:=([\w-]+))?$/.exec(flag);
    if (!m) return;
    // `--unhandled-rejections=warn` or `--unhandled-rejections warn`.
    const value = m[1] ?? flags[i + 1];
    if (value && /^[\w-]+$/.test(value)) mode = value;
  });
  return mode;
}

/**
 * Report a crash before the process dies of it.
 *
 * Node's own behavior is kept: an uncaught exception, and an unhandled
 * rejection in Node's default mode (since v15 it ends the process), still end
 * the process with exit code 1 and the error on stderr. What changes is that
 * the error is reported first, waiting at most `flushMs` (2 s) for it to
 * leave; the process keeps answering in that window, as it would while Node
 * printed the error. A process started with `--unhandled-rejections=warn`,
 * `warn-with-error-code` or `none` keeps running after a rejection, as it did
 * before: the rejection is reported, not made fatal. A second crash while the
 * first is being reported is queued and the process still exits once.
 * Installed only when a reporter exists; returns the undo, for tests.
 */
export function installProcessErrorHooks(reporter: ErrorReporter, opts: ProcessHookOptions = {}): () => void {
  const proc = opts.proc ?? process;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const flushMs = opts.flushMs ?? 2_000;
  const log = opts.log ?? ((message: string, error: unknown) => console.error(message, error));
  const rejectionMode = opts.unhandledRejections ?? unhandledRejectionsMode();
  let crashing = false;

  const fatal = (error: unknown, mechanism: 'uncaught_exception' | 'unhandled_rejection') => {
    reporter.report(error, { handled: false, mechanism });
    if (crashing) return;
    crashing = true;
    log(`[api] ${mechanism === 'unhandled_rejection' ? 'unhandled rejection' : 'uncaught exception'}, exiting:`, error);
    // However the flush ends, the process ends: a hung provider cannot keep a broken process alive.
    const hardStop = setTimeout(() => exit(1), flushMs + 1_000);
    void reporter.flush(flushMs).finally(() => {
      clearTimeout(hardStop);
      exit(1);
    });
  };
  const onException = (error: unknown) => fatal(error, 'uncaught_exception');
  const onRejection = (reason: unknown) => {
    if (rejectionMode === 'warn' || rejectionMode === 'warn-with-error-code' || rejectionMode === 'none') {
      // The mode this process was started in keeps it alive: report, and say
      // so as Node would have.
      reporter.report(reason, { handled: false, mechanism: 'unhandled_rejection' });
      // `warn` prints Node's own warning whatever the hook; the other two are silent with one.
      if (rejectionMode === 'warn-with-error-code') log('[api] unhandled rejection:', reason);
      if (rejectionMode === 'warn-with-error-code') process.exitCode = 1;
      return;
    }
    fatal(reason, 'unhandled_rejection');
  };
  proc.on('uncaughtException', onException);
  proc.on('unhandledRejection', onRejection);
  return () => {
    proc.off('uncaughtException', onException);
    proc.off('unhandledRejection', onRejection);
  };
}
