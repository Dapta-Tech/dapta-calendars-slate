/**
 * The API answered 429: too many requests just now. Not an outage and not the
 * visitor's mistake, so it is never reported as either. The visitor is told
 * the service is busy for a moment, the page asks again on its own after the
 * API's `Retry-After`, and a "Try again" button is always there.
 *
 * Plain module (no server-only imports) so the server fetchers, the route
 * handler and the client island share one reading of it.
 */

/** The longest wait a `Retry-After` is taken at its word for. */
export const MAX_RETRY_AFTER_MS = 30_000;
/** The wait assumed when a 429 names none. */
export const DEFAULT_RETRY_AFTER_MS = 2_000;

/** Thrown by a server-side fetcher when the API answered 429. */
export class ApiBusyError extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super('The scheduling service is busy');
    this.name = 'ApiBusyError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** The marker a page renders a busy state from, instead of throwing. */
export interface Busy {
  busy: true;
  retryAfterMs: number;
}

export function isBusy(v: unknown): v is Busy {
  return !!v && typeof v === 'object' && (v as { busy?: unknown }).busy === true;
}

/**
 * A `Retry-After` header as milliseconds to wait: delta-seconds or an HTTP
 * date, clamped to [0, MAX_RETRY_AFTER_MS]. Absent or unreadable: the default.
 */
export function retryAfterMsOf(header: string | null | undefined, now = Date.now()): number {
  if (!header) return DEFAULT_RETRY_AFTER_MS;
  const seconds = Number(header.trim());
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - now;
  if (!Number.isFinite(ms)) return DEFAULT_RETRY_AFTER_MS;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, Math.round(ms)));
}

/**
 * Await `p`; a busy API becomes a `Busy` marker the page can render, and every
 * other failure (including Next's own `notFound`/redirect signals) is rethrown
 * untouched.
 */
export async function orBusy<T>(p: Promise<T>): Promise<T | Busy> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof ApiBusyError) return { busy: true, retryAfterMs: err.retryAfterMs };
    throw err;
  }
}
