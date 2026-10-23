import { Catch, HttpException, Inject, Logger, Optional, type ArgumentsHost } from '@nestjs/common';
import { BaseExceptionFilter, HttpAdapterHost } from '@nestjs/core';
import type { ServerEnv } from '@slate/config/env';
import {
  analyticsErrorsEnabled,
  createErrorReporter,
  hostOfUrl,
  reportableHost,
  type ErrorReporter,
  type ErrorReporterOptions,
} from '@slate/shared';
import type { AnalyticsProvider } from './analytics.provider';
import { requestErrorContext } from './request-log';
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

/** The API's reporter: a shared one, plus whether a request may name its own `$host`. */
export interface ApiErrorReporter extends ErrorReporter {
  /** True when no public API host is configured, so a request's own (public) Host header is the best name. */
  readonly useRequestHost: boolean;
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
): ApiErrorReporter | null {
  const capture = provider?.captureException?.bind(provider);
  if (!capture || !analyticsErrorsEnabled(env.PRODUCT_ANALYTICS_ERRORS)) return null;
  // `$host` names the public address the error belongs to, never a pod's: the
  // configured public API host; without one, a request's own Host header when
  // it is a public name (see `reportRequestError`); for anything else (a
  // crash, an internal caller) the deployment's public app host.
  const apiHost = hostOfUrl(env.API_PUBLIC_URL);
  const host = apiHost ?? hostOfUrl(env.PUBLIC_APP_URL);
  const log = new Logger('ErrorTracking');
  let lastWarning = 0;
  const reporter = createErrorReporter({
    deliver: capture,
    properties: { surface: 'api', ...(host ? { $host: host } : {}) },
    root: process.cwd(),
    onDrop: (reason) => {
      const now = Date.now();
      if (now - lastWarning < DROP_WARNING_EVERY_MS) return;
      lastWarning = now;
      log.warn(`error reports are being dropped (${reason}); the log still has every error`);
    },
    ...overrides,
  });
  return Object.assign(reporter, { useRequestHost: apiHost === null });
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
    const host = (reporter as Partial<ApiErrorReporter>).useRequestHost
      ? reportableHost((req as { headers?: Record<string, unknown> } | null)?.headers?.['host'])
      : null;
    reporter.report(exception, {
      handled: false,
      mechanism: 'filter',
      properties: { ...requestErrorContext(req, opts.requestId), status, ...(host ? { $host: host } : {}) },
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
    if (host.getType() === 'http') reportRequestError(this.reporter, exception, host.switchToHttp().getRequest());
    super.catch(exception, host);
  }
}

/** What the process hooks need, injectable so a test never touches the real process. */
export interface ProcessHookOptions {
  proc?: Pick<NodeJS.Process, 'on' | 'off'>;
  exit?: (code: number) => void;
  /** How long a crash waits for its own report to leave. */
  flushMs?: number;
  log?: (message: string, error: unknown) => void;
}

/**
 * Report a crash before the process dies of it.
 *
 * Node's own behavior is kept: an uncaught exception, and an unhandled
 * rejection (Node's default since v15 turns it into one), still end the
 * process with exit code 1 and the error on stderr. What changes is that the
 * error is reported first, waiting at most `flushMs` (2 s) for it to leave.
 * A second crash while the first is being reported is queued and the process
 * still exits once. Installed only when a reporter exists; returns the undo,
 * for tests.
 */
export function installProcessErrorHooks(reporter: ErrorReporter, opts: ProcessHookOptions = {}): () => void {
  const proc = opts.proc ?? process;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const flushMs = opts.flushMs ?? 2_000;
  const log = opts.log ?? ((message: string, error: unknown) => console.error(message, error));
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
  const onRejection = (reason: unknown) => fatal(reason, 'unhandled_rejection');
  proc.on('uncaughtException', onException);
  proc.on('unhandledRejection', onRejection);
  return () => {
    proc.off('uncaughtException', onException);
    proc.off('unhandledRejection', onRejection);
  };
}
