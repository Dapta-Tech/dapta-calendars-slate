import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * One line per request, written when the response ends.
 *
 * Before this the API left no trace of what it served: the only log lines were
 * boot lines and the occasional warning, so "is it working for users?" could
 * not be answered from the deployment's own logs.
 *
 * What a line carries, and what it deliberately does not:
 *
 *   method, route TEMPLATE (`/v1/bookings/:uid`, never the raw path: uids,
 *   tokens and handles live in paths), status, duration, request id, the
 *   `error` code when the body carries one, and the account when known (the
 *   `:accountCode` route parameter, or the authenticated account id).
 *
 *   No query string (manage tokens still ride `?token=` on old links), no
 *   bodies, no headers, no client address, no emails or names. A route that
 *   matched nothing logs `(unmatched)` rather than the path it was asked for.
 *
 * Health probes are skipped: they fire every few seconds per replica and would
 * drown everything else.
 */

export interface RequestLogLine {
  ts: string;
  level: 'info' | 'warn' | 'error';
  msg: 'request';
  requestId: string;
  method: string;
  route: string;
  status: number;
  durationMs: number;
  code?: string;
  account?: string;
  accountId?: string;
  /** The client went away before the response finished. */
  aborted?: true;
}

export interface RequestLogOptions {
  /** `json` = one JSON object per line (production); `pretty` = a human line. */
  format: 'json' | 'pretty';
  /** Where lines go. Defaults to stdout. */
  write?: (line: string) => void;
  now?: () => bigint;
}

/** Accept a caller's id only when it is short and boring; otherwise mint one. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,100}$/;
/** Account codes and vanity slugs are short lowercase-ish tokens. */
const SAFE_ACCOUNT_CODE = /^[A-Za-z0-9_-]{1,64}$/;
const SKIP = /^\/health(\/|$)/;

const ACCOUNT_ID = Symbol('requestLog.accountId');
const ERROR_CODE = Symbol('requestLog.errorCode');
const IS_INTERNAL = Symbol('requestLog.isInternal');

type Annotated = Request & { [ACCOUNT_ID]?: string; [ERROR_CODE]?: string; [IS_INTERNAL]?: boolean };

/**
 * Record the authenticated account on the request so its log line can carry
 * it. Called by the auth layer once a principal is resolved; a no-op on
 * anything that is not an HTTP request object.
 */
export function annotateRequestAccount(req: unknown, accountId: string): void {
  if (req && typeof req === 'object') (req as Annotated)[ACCOUNT_ID] = accountId;
}

/**
 * Record whether the signed-in host is one of the operator's own people
 * (`PRODUCT_ANALYTICS_INTERNAL_EMAILS`), so an error report can say so. Only
 * the boolean is kept, never the email it was decided from.
 */
export function annotateRequestInternal(req: unknown, isInternal: boolean): void {
  if (req && typeof req === 'object') (req as Annotated)[IS_INTERNAL] = isInternal;
}

/**
 * The one request-id rule for the whole API (this middleware and the v2
 * interceptor): keep a caller's id when it is safe to echo and log, else mint.
 */
export function requestIdFrom(raw: string | string[] | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && SAFE_REQUEST_ID.test(value) ? value : `req_${randomUUID()}`;
}

/** The `error` code of an error body: `{ error: 'CODE' }` or `{ error: { code } }`. */
function errorCode(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const error = (body as Record<string, unknown>)['error'];
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const code = (error as Record<string, unknown>)['code'];
    if (typeof code === 'string') return code;
  }
  return undefined;
}

function routeTemplate(req: Request): string {
  const path = (req.route as { path?: unknown } | undefined)?.path;
  return typeof path === 'string' ? `${req.baseUrl ?? ''}${path}` : '(unmatched)';
}

/**
 * The account code from the matched route's `:accountCode` parameter only. The
 * query string is never read, not even for this one field: whatever a caller
 * puts there would otherwise reach the log.
 */
function accountCode(req: Request): string | undefined {
  const code = (req.params as Record<string, unknown> | undefined)?.['accountCode'];
  return typeof code === 'string' && SAFE_ACCOUNT_CODE.test(code) ? code : undefined;
}

/**
 * What an error report may say about the request it came from, by the same
 * rules as the log line: the route TEMPLATE, the method, the request id, the
 * `:accountCode` route parameter, and whether the host is internal when the
 * auth layer resolved one. Never the path, the query, a header or the body.
 */
export function requestErrorContext(req: unknown, requestId?: string): Record<string, string | boolean> {
  if (!req || typeof req !== 'object') return {};
  const r = req as Annotated;
  const out: Record<string, string | boolean> = {
    route: routeTemplate(r),
    method: typeof r.method === 'string' ? r.method : 'UNKNOWN',
    request_id: requestId ?? requestIdFrom(r.headers?.['x-request-id']),
  };
  const account = accountCode(r);
  if (account) out['account_code'] = account;
  if (typeof r[IS_INTERNAL] === 'boolean') out['is_internal'] = r[IS_INTERNAL];
  return out;
}

export function formatPretty(l: RequestLogLine): string {
  const extras = [
    l.code ? `code=${l.code}` : '',
    l.account ? `account=${l.account}` : '',
    l.accountId ? `accountId=${l.accountId}` : '',
    l.aborted ? 'aborted' : '',
  ].filter(Boolean);
  return `[http] ${l.method} ${l.route} ${l.status} ${l.durationMs}ms ${l.requestId}${extras.length ? ' ' + extras.join(' ') : ''}`;
}

export function requestLogger(opts: RequestLogOptions) {
  const write = opts.write ?? ((line: string) => process.stdout.write(line + '\n'));
  const now = opts.now ?? (() => process.hrtime.bigint());

  return function requestLog(req: Request, res: Response, next: NextFunction): void {
    const requestId = requestIdFrom(req.headers['x-request-id']);
    // Downstream readers (the v2 interceptor) see the same id.
    req.headers['x-request-id'] = requestId;
    res.setHeader('X-Request-Id', requestId);
    if (SKIP.test(req.path)) return next();

    const started = now();
    // Every error body in this API goes out through `res.json` (Nest's reply
    // path and the v2 filter alike); note its code on the way past.
    const json = res.json.bind(res);
    res.json = (body: unknown) => {
      const code = errorCode(body);
      if (code) (req as Annotated)[ERROR_CODE] = code;
      return json(body);
    };

    let done = false;
    const finish = (aborted: boolean) => {
      if (done) return;
      done = true;
      const status = aborted ? 499 : res.statusCode;
      const line: RequestLogLine = {
        ts: new Date().toISOString(),
        level: status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info',
        msg: 'request',
        requestId,
        method: req.method,
        route: routeTemplate(req),
        status,
        durationMs: Math.round(Number(now() - started) / 1e6),
      };
      const code = (req as Annotated)[ERROR_CODE];
      if (code) line.code = code;
      const account = accountCode(req);
      if (account) line.account = account;
      const accountId = (req as Annotated)[ACCOUNT_ID];
      if (accountId) line.accountId = accountId;
      if (aborted) line.aborted = true;
      try {
        write(opts.format === 'json' ? JSON.stringify(line) : formatPretty(line));
      } catch {
        /* logging must never break a response */
      }
    };
    res.on('finish', () => finish(false));
    res.on('close', () => finish(!res.writableFinished));
    next();
  };
}
