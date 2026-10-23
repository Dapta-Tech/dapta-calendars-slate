/**
 * Error tracking: the deployment's OWN record of what broke, sent to the same
 * analytics project as product analytics (see `analytics.ts`) and off with it.
 * Vendor-neutral and shared by the API, the Next server and the browser, so
 * every surface scrubs an error the same way before it leaves.
 *
 * What is here:
 *  - `scrubErrorText` / `scrubFrameFilename`: the privacy filter every error
 *    message, type and stack frame passes through, on every surface.
 *  - `describeError`: an error (and its causes) as plain, scrubbed data.
 *  - `createErrorReporter`: the server side's bounded, rate-limited,
 *    de-duplicating queue. Nothing in it touches a database: an outage of the
 *    database must still be reportable.
 *  - `exceptionEvent` / `sendAnalyticsEvent`: the wire shape and the one POST
 *    helper, for the configured provider (`AnalyticsConfig`).
 *
 * What never leaves, on any surface: a request body, a form answer, a header
 * or cookie, a query string, an email address, a phone number, a long digit
 * run, a bearer or API token. Only the error's type, its scrubbed message, its
 * stack frames (file, function, line) and the context a caller names
 * (route template, method, status, request id) are sent.
 */
import { ANALYTICS_PRODUCT, type AnalyticsConfig, type AnalyticsProps } from './analytics';

/* -------------------------------------------------------------- scrubbing */

/** The longest message sent. An error message is a sentence, not a payload. */
export const ERROR_MESSAGE_MAX = 1000;

/** One rule of the scrubber: a name (for the tests) and what it does. */
export interface ScrubRule {
  readonly name: string;
  apply(text: string): string;
}

/**
 * A URL's address only: scheme, host and path. Its credentials (`user:pass@`),
 * query and fragment go: a query can carry anything a link builder put there
 * (a prefilled email, a manage token, a CRM's ids).
 */
function urlWithoutQuery(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#@\s]*@/i, '$1').replace(/[?#].*$/s, '');
}

/** One IPv4 octet as written in an address: 0 to 255, no leading zero. */
const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';

/**
 * Values the scrubber must leave whole, parked while the number rules run: a
 * UUID, an ISO date or timestamp, an IPv4 address (with its port). Strict on
 * purpose: a dotted phone (`06.12.34.56.78`) or an id written with dot
 * separators (`1.023.456.789`) is not an address and is not parked.
 */
const PROTECTED = new RegExp(
  [
    '\\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\b',
    '\\b(?:19|20)\\d{2}-[01]\\d-[0-3]\\d(?:[T ][0-2]\\d:[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|[+-][0-2]\\d:?[0-5]\\d)?)?\\b',
    `(?<![\\d.])${OCTET}(?:\\.${OCTET}){3}(?::\\d{1,5})?(?![.\\d])`,
  ].join('|'),
  'gi',
);

/** A private-use character: no rule matches it, and no real message carries it. */
const MARK = '\uE000';
const PARKED = new RegExp(`${MARK}(\\d+)${MARK}`, 'g');

/** Park every protected value behind a marker no rule matches, and give back the way home. */
function park(text: string): { text: string; restore(t: string): string } {
  const kept: string[] = [];
  const parked = text.replace(PROTECTED, (m) => `${MARK}${kept.push(m) - 1}${MARK}`);
  return {
    text: parked,
    restore: (t) => t.replace(PARKED, (_, i: string) => kept[Number(i)] ?? ''),
  };
}

/**
 * The scrubber's rules, in the order they run. Each one has its own tests, and
 * the spec proves every one of them is needed by running the scrubber without
 * it (`error-reporting.spec.ts`).
 */
export const SCRUB_RULES: readonly ScrubRule[] = [
  {
    // A database driver's "Failed query: ... params: <the values>" carries the
    // row being written: an invitee's name, email, answers. Everything after
    // `params:` goes, whatever it spans.
    name: 'query-params',
    apply: (t) => t.replace(/\bparams:[\s\S]*$/i, 'params: [redacted]'),
  },
  {
    // A database's "invalid input syntax for type uuid: "<what was sent>"":
    // the quoted part is whatever a caller typed into that field.
    name: 'quoted-input',
    apply: (t) => t.replace(/(invalid input (?:syntax|value) for (?:type |enum )?[\w ]{1,40}:\s*)"[^"]*"/gi, '$1"[redacted]"'),
  },
  {
    name: 'url-query',
    apply: (t) => t.replace(/\b[a-z][a-z0-9+.-]{0,31}:\/\/[^\s"'<>`()[\]{}]+/gi, urlWithoutQuery),
  },
  {
    // A path with a query, outside a full URL: "API /v1/x?email=... failed".
    name: 'path-query',
    apply: (t) => t.replace(/(\S)\?[\w.%[\]-]+=[^\s"'<>`]*/g, '$1'),
  },
  {
    name: 'bearer',
    apply: (t) => t.replace(/\b(Bearer|Basic)\s+[^\s"',;]+/gi, '$1 [token]'),
  },
  {
    name: 'jwt',
    apply: (t) => t.replace(/\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*/g, '[token]'),
  },
  {
    // Prefixed keys: payment and analytics keys (`sk_`, `pk_`, `phc_`, `phx_`),
    // this app's own API keys (`dcl_`), webhook secrets, code-host tokens.
    name: 'prefixed-key',
    apply: (t) =>
      t.replace(/\b(?:sk|pk|rk|phc|phx|dcl|whsec|ghp|gho|ghs|github_pat|xox[abprs])_[A-Za-z0-9_-]{6,}|\bsk-[A-Za-z0-9_-]{10,}/g, '[token]'),
  },
  {
    // `key=...`, `token=...`, `"password": "..."`: a secret by its name.
    name: 'named-secret',
    apply: (t) =>
      t
        .replace(
          /\b(api[_-]?key|key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|client[_-]?secret|secret|password|passwd|pwd|signature|sig|code)=[^\s"'&,;]+/gi,
          '$1=[redacted]',
        )
        // A JSON-style key, quoted: `"token": "..."`.
        .replace(
          /(["'])(api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|client[_-]?secret|secret|password|passwd|authorization)\1(\s*:\s*)(?:"[^"]*"|'[^']*'|[^\s"',;}]+)/gi,
          '$1$2$1$3"[redacted]"',
        )
        // Unquoted, only names that are never anything else ("Unexpected token: <" keeps its token).
        .replace(
          /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd)(\s*:\s*)[^\s"',;}]+/gi,
          '$1$2[redacted]',
        ),
  },
  {
    // Plain and URL-encoded (`%40`) addresses. Bounded like the addresses
    // themselves (64 before the `@`, 63 per label), so a long run of
    // address-like characters costs linear time, not quadratic.
    name: 'email',
    apply: (t) =>
      t
        .replace(/[\p{L}\p{N}._%+'-]{1,64}@[\p{L}\p{N}-]{1,63}(?:\.[\p{L}\p{N}-]{1,63}){0,8}\.\p{L}{2,24}/gu, '[email]')
        .replace(/[\w.%+-]{1,64}%(?:25)?40[\w-]{1,63}(?:\.[\w-]{1,63}){0,8}\.[a-z]{2,24}/gi, '[email]'),
  },
  {
    // `+57 300 123 4567`, `+1 (555) 123-4567`, `+573001234567`.
    name: 'phone-international',
    apply: (t) => t.replace(/\+\p{Nd}(?:[ \t\u00a0().\u2013-]{0,2}\p{Nd}){6,14}/gu, '[phone]'),
  },
  {
    // National formats, digit blocks joined by a space (a no-break one too),
    // a dot, a dash (an en dash too) or brackets: `300 123 4567`,
    // `(11) 98765-4321`, `555.123.4567`. Seven to fifteen digits in two or
    // more blocks is a phone; more than fifteen (a card number written in
    // groups, a phone beside another number) is a number. IP addresses,
    // dates and UUIDs are set aside before this runs, so they survive.
    name: 'phone-national',
    apply: (t) =>
      t.replace(
        /(?<![\p{L}\p{N}_+])\(?\p{Nd}{1,8}\)?(?:[ .\u00a0\u2013-]{1,2}\(?\p{Nd}{1,8}\)?)+(?![\p{L}\p{N}_])/gu,
        (m) => {
          const digits = m.replace(/\P{Nd}/gu, '').length;
          if (digits > 15) return '[number]';
          return digits >= 7 ? '[phone]' : m;
        },
      ),
  },
  {
    // An unbroken run of seven or more digits: a phone without separators, an
    // account or card number, an epoch. Nothing an error needs to be grouped.
    name: 'digit-run',
    apply: (t) => t.replace(/\p{Nd}{7,}/gu, '[number]'),
  },
];

/** The rules that read numbers, which run with IPs, dates and UUIDs parked. */
const NUMBER_RULES = new Set(['phone-international', 'phone-national', 'digit-run']);

/**
 * An error's message (or type, or a breadcrumb) fit to leave the process: every
 * rule in `SCRUB_RULES` applied, then cut to `ERROR_MESSAGE_MAX`. Never throws.
 */
export function scrubErrorText(text: unknown, rules: readonly ScrubRule[] = SCRUB_RULES): string {
  if (typeof text !== 'string' || !text) return '';
  // Bounded work whatever arrives: only twice what can be sent is read, and a
  // word cut in half at that edge is dropped whole, so no partial address or
  // number is left for the rules to miss.
  let out = text.length > ERROR_MESSAGE_MAX * 2 ? text.slice(0, ERROR_MESSAGE_MAX * 2).replace(/\S*$/, '') : text;
  // Compatibility forms first, so a full-width `＠` or digit reads as itself.
  out = out.normalize('NFKC');
  for (const rule of rules) {
    if (NUMBER_RULES.has(rule.name)) {
      const parked = park(out);
      out = parked.restore(rule.apply(parked.text));
    } else {
      out = rule.apply(out);
    }
  }
  return out.length > ERROR_MESSAGE_MAX ? `${out.slice(0, ERROR_MESSAGE_MAX)}...` : out;
}

/**
 * A stack frame's file, fit to send: no `file://` scheme, nothing after a `?`
 * or `#`, and relative to `root` (the process's working directory on a
 * server) so the same frame reads the same on every machine and a build
 * directory's path is not shipped.
 */
export function scrubFrameFilename(filename: unknown, root?: string): string | undefined {
  if (typeof filename !== 'string' || !filename) return undefined;
  let out = filename.replace(/[?#].*$/s, '');
  if (out.startsWith('file://')) out = out.slice('file://'.length);
  if (root) {
    const prefix = root.endsWith('/') ? root : `${root}/`;
    if (out.startsWith(prefix)) out = out.slice(prefix.length);
  }
  return out;
}

/* ------------------------------------------------------------ describing */

/** One stack frame, oldest first in a list (the failing line is the last one). */
export interface ErrorFrame {
  filename?: string;
  function?: string;
  lineno?: number;
  colno?: number;
  /** False for the runtime's own code and for dependencies. */
  in_app: boolean;
}

/** One exception of a chain: the error itself, then its causes. */
export interface ExceptionEntry {
  type: string;
  value: string;
  frames: ErrorFrame[];
}

/**
 * An error whose message quotes something that must never leave (an upstream
 * service's response body, say) names what may be reported instead under
 * this key: `error[REPORTABLE_MESSAGE] = 'calendar backend listBusy failed (502)'`.
 * `describeError` sends that, scrubbed, in place of the message. A
 * well-known symbol, so code that cannot import this package can set it too.
 */
export const REPORTABLE_MESSAGE: unique symbol = Symbol.for('slate.reportable-message');

/** The most frames kept per exception, nearest the failure. */
const MAX_FRAMES = 50;
/** The most causes followed (`error.cause`). */
const MAX_CAUSES = 3;

/** `    at fn (file:line:col)`, `    at file:line:col`, `    at async fn (file:line:col)`. */
const V8_FRAME = /^\s*at (?:(?:async )?(.*?) \()?(.+?):(\d+):(\d+)\)?\s*$/;

/** The runtime's own code and installed dependencies: not this app. */
const DEPENDENCY = /(^node:|^internal\/|\/node_modules\/)/;

/**
 * This repository's own packages (`@slate/*`), as a deployed bundle installs
 * them (`node_modules/.pnpm/@slate+db@.../node_modules/@slate/db/src/x.ts`):
 * app code, reported as `@slate/db/src/x.ts`.
 */
const OWN_PACKAGE = /\/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?(@slate\/.+)$/;

/**
 * Parse a V8 stack (the server runtimes) into frames, oldest first. A line
 * that is not a frame (the message, a "From previous event") is skipped.
 */
export function parseStackFrames(stack: unknown, root?: string): ErrorFrame[] {
  if (typeof stack !== 'string') return [];
  const frames: ErrorFrame[] = [];
  for (const line of stack.split('\n')) {
    const m = V8_FRAME.exec(line);
    if (!m) continue;
    const file = m[2]!;
    const own = OWN_PACKAGE.exec(file)?.[1];
    const filename = own ? scrubFrameFilename(own) : scrubFrameFilename(file, root);
    const fn = m[1] ? scrubErrorText(m[1]).slice(0, 200) : '';
    frames.push({
      ...(filename ? { filename } : {}),
      ...(fn ? { function: fn } : {}),
      lineno: Number(m[3]),
      colno: Number(m[4]),
      in_app: own !== undefined || !DEPENDENCY.test(file),
    });
  }
  return frames.slice(0, MAX_FRAMES).reverse();
}

/**
 * The type of a thrown value. A thrown string or number is reported as what
 * it is; an object that is not an Error is never serialized (it could be a
 * request body), only named.
 */
function typeOf(value: unknown): string {
  if (value instanceof Error) return value.name || value.constructor?.name || 'Error';
  if (value === null) return 'null';
  if (typeof value === 'object') return (value as { constructor?: { name?: string } }).constructor?.name || 'Object';
  return typeof value;
}

function messageOf(value: unknown): string {
  if (value instanceof Error) {
    const reportable = (value as { [REPORTABLE_MESSAGE]?: unknown })[REPORTABLE_MESSAGE];
    return typeof reportable === 'string' ? reportable : value.message;
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return value === undefined || value === null ? String(value) : 'Non-Error value thrown';
}

/** Reads an error's stack where the runtime keeps a better one than `error.stack` (see `stackOf`). */
export type StackReader = (error: Error) => string | undefined;

/**
 * A thrown value and its causes as scrubbed data: type, message and frames,
 * outermost first. Never throws, whatever it is handed.
 */
export function describeError(error: unknown, root?: string, stackOf?: StackReader): ExceptionEntry[] {
  const out: ExceptionEntry[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (out.length <= MAX_CAUSES && !seen.has(current)) {
    seen.add(current);
    try {
      out.push({
        type: scrubErrorText(typeOf(current)) || 'Error',
        value: scrubErrorText(messageOf(current)),
        frames: current instanceof Error ? parseStackFrames(stackFrames(current, stackOf), root) : [],
      });
    } catch {
      out.push({ type: 'Error', value: '', frames: [] });
    }
    let cause: unknown;
    try {
      cause = current instanceof Error ? (current as { cause?: unknown }).cause : undefined;
    } catch {
      cause = undefined;
    }
    if (cause === undefined) break;
    current = cause;
  }
  return out;
}

/**
 * An error's stack without its `Name: message` header, so a line of the
 * message shaped like a frame is never read as one (and never carries what
 * the scrubbed message hid).
 */
function stackFrames(error: Error, stackOf?: StackReader): string {
  let stack = typeof error.stack === 'string' ? error.stack : '';
  try {
    const better = stackOf?.(error);
    if (typeof better === 'string' && better) stack = better;
  } catch {
    /* the plain stack, then */
  }
  const message = typeof error.message === 'string' ? error.message : '';
  // The header spans as many lines as the message, whatever name it was given.
  return stack.split('\n').slice(Math.max(1, message.split('\n').length)).join('\n');
}

/* -------------------------------------------------------------- reporter */

/** One error, ready to send. */
export interface ErrorReport {
  /** Idempotency key. */
  uuid: string;
  /** Epoch ms the error HAPPENED (for a repeat: when the window closed). */
  timestamp: number;
  /** The error and its causes, outermost first, scrubbed. */
  exceptions: ExceptionEntry[];
  /** False for what nothing caught (a crash, an unhandled rejection, a 5xx). */
  handled: boolean;
  /** How it was caught: `filter`, `uncaught_exception`, `unhandled_rejection`, `on_request_error`. */
  mechanism: string;
  /**
   * How many occurrences this event stands for: 1 for the first in a dedupe
   * window, and on the repeat sent when the window closes, how many more
   * arrived in it. The sum over events is the true count.
   */
  count: number;
  /** The caller's context (route template, method, status, request id) and the reporter's own. */
  properties: AnalyticsProps;
}

export interface ReportInput {
  properties?: AnalyticsProps;
  handled?: boolean;
  mechanism?: string;
}

export interface ErrorReporterOptions {
  /** Hands one report to the provider. A rejection is swallowed: telemetry never fails the caller. */
  deliver(report: ErrorReport): Promise<void>;
  /** Properties on every report (`product`, `source`, `$host`). */
  properties?: AnalyticsProps;
  /** The process's working directory: frames are sent relative to it. */
  root?: string;
  /**
   * Where the runtime keeps a better stack than `error.stack` (one with
   * source maps applied that `error.stack` does not have): read from there.
   */
  stackOf?: StackReader;
  /** Reports waiting to be built and sent. Past this, new ones are dropped. Default 100. */
  maxQueue?: number;
  /** Reports sent per rolling minute, repeats included. Past this, dropped. Default 60. */
  maxPerMinute?: number;
  /** The same error (type, message, failing frame) within this window is sent once. Default 60 s. */
  dedupeWindowMs?: number;
  now?: () => number;
  /** Runs the drain off the caller's path. Default: `setImmediate`, else `setTimeout(0)`. */
  schedule?: (fn: () => void) => void;
  /** Wakes the reporter when a dedupe window closes. Default: an unref'd `setTimeout`. */
  setTimer?: (fn: () => void, ms: number) => void;
  uuid?: () => string;
  /** Told about every drop, so an operator can see the reporter shedding load. */
  onDrop?: (reason: 'queue_full' | 'rate_limited') => void;
}

export interface ErrorReporter {
  /** Queue an error. Returns at once, never throws, never waits on the network. */
  report(error: unknown, input?: ReportInput): void;
  /** Send everything queued and every pending repeat now; wait at most `timeoutMs` for delivery. */
  flush(timeoutMs?: number): Promise<void>;
  /** Counters, for tests and diagnostics. */
  readonly stats: { readonly sent: number; readonly folded: number; readonly dropped: number };
}

interface Queued {
  error: unknown;
  input: ReportInput;
  at: number;
}

interface Window {
  first: number;
  folded: number;
  sample: ErrorReport;
}

/** The most dedupe windows remembered; the oldest is closed first. */
const MAX_WINDOWS = 500;

type Timers = {
  setImmediate?: (fn: () => void) => unknown;
  setTimeout: (fn: () => void, ms: number) => unknown;
  crypto?: { randomUUID?: () => string };
};

const timers = globalThis as unknown as Timers;

function defaultSchedule(fn: () => void): void {
  if (typeof timers.setImmediate === 'function') timers.setImmediate(fn);
  else timers.setTimeout(fn, 0);
}

function defaultTimer(fn: () => void, ms: number): void {
  const handle = timers.setTimeout(fn, ms) as { unref?: () => void } | undefined;
  handle?.unref?.();
}

function defaultUuid(): string {
  const random = timers.crypto?.randomUUID;
  if (typeof random === 'function') return random.call(timers.crypto);
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

/** What makes two errors the same one: type, scrubbed message, and the failing frame. */
export function errorFingerprint(exceptions: readonly ExceptionEntry[]): string {
  const head = exceptions[0];
  if (!head) return 'empty';
  const frames = head.frames;
  const top = [...frames].reverse().find((f) => f.in_app) ?? frames[frames.length - 1];
  const where = top ? `${top.filename ?? ''}:${top.function ?? ''}:${top.lineno ?? ''}` : '';
  return `${head.type}|${head.value}|${where}`;
}

/**
 * A server-side error reporter: fire-and-forget, bounded, rate limited and
 * de-duplicated, with no database anywhere in its path.
 *
 *  - `report()` only queues (at most `maxQueue`) and schedules a drain off
 *    the caller's path; building, scrubbing and sending happen there.
 *  - The first occurrence of an error is sent at once. Further occurrences
 *    within `dedupeWindowMs` are counted, and when the window closes one more
 *    event carries how many there were (`count`).
 *  - At most `maxPerMinute` events leave per rolling minute; the rest are
 *    dropped and counted.
 */
export function createErrorReporter(options: ErrorReporterOptions): ErrorReporter {
  const maxQueue = options.maxQueue ?? 100;
  const maxPerMinute = options.maxPerMinute ?? 60;
  const windowMs = options.dedupeWindowMs ?? 60_000;
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? defaultSchedule;
  const setTimer = options.setTimer ?? defaultTimer;
  const uuid = options.uuid ?? defaultUuid;
  const base = options.properties ?? {};

  const queue: Queued[] = [];
  const windows = new Map<string, Window>();
  const sentAt: number[] = [];
  const inflight = new Set<Promise<void>>();
  const stats = { sent: 0, folded: 0, dropped: 0 };
  let scheduled = false;
  let timerArmed = false;

  const drop = (reason: 'queue_full' | 'rate_limited') => {
    stats.dropped += 1;
    try {
      options.onDrop?.(reason);
    } catch {
      /* never into the caller */
    }
  };

  const send = (report: ErrorReport) => {
    const t = now();
    while (sentAt.length > 0 && t - sentAt[0]! >= 60_000) sentAt.shift();
    if (sentAt.length >= maxPerMinute) return drop('rate_limited');
    sentAt.push(t);
    stats.sent += 1;
    let p: Promise<void>;
    try {
      p = Promise.resolve(options.deliver(report)).catch(() => undefined);
    } catch {
      return;
    }
    const tracked = p.finally(() => inflight.delete(tracked));
    inflight.add(tracked);
  };

  /** Close windows that are over (or all of them), sending a repeat for each one that folded something. */
  const sweep = (all: boolean) => {
    const t = now();
    for (const [key, w] of windows) {
      if (!all && t - w.first < windowMs) continue;
      windows.delete(key);
      if (w.folded > 0) send({ ...w.sample, uuid: uuid(), timestamp: t, count: w.folded });
    }
  };

  const armTimer = () => {
    if (timerArmed) return;
    timerArmed = true;
    setTimer(() => {
      timerArmed = false;
      try {
        sweep(false);
        if ([...windows.values()].some((w) => w.folded > 0)) armTimer();
      } catch {
        /* never into the caller */
      }
    }, windowMs);
  };

  const build = (item: Queued): ErrorReport => ({
    uuid: uuid(),
    timestamp: item.at,
    exceptions: describeError(item.error, options.root, options.stackOf),
    handled: item.input.handled ?? false,
    mechanism: item.input.mechanism ?? 'generic',
    count: 1,
    properties: { ...base, ...(item.input.properties ?? {}) },
  });

  const drain = () => {
    scheduled = false;
    sweep(false);
    for (const item of queue.splice(0)) {
      let report: ErrorReport;
      try {
        report = build(item);
      } catch {
        continue;
      }
      const key = errorFingerprint(report.exceptions);
      const w = windows.get(key);
      if (w && item.at - w.first < windowMs) {
        w.folded += 1;
        stats.folded += 1;
        armTimer();
        continue;
      }
      if (w) {
        windows.delete(key);
        if (w.folded > 0) send({ ...w.sample, uuid: uuid(), timestamp: now(), count: w.folded });
      }
      windows.set(key, { first: item.at, folded: 0, sample: report });
      while (windows.size > MAX_WINDOWS) {
        const [oldest, ow] = windows.entries().next().value as [string, Window];
        windows.delete(oldest);
        if (ow.folded > 0) send({ ...ow.sample, uuid: uuid(), timestamp: now(), count: ow.folded });
      }
      send(report);
    }
  };

  return {
    stats,
    report(error, input = {}) {
      try {
        if (queue.length >= maxQueue) return drop('queue_full');
        queue.push({ error, input, at: now() });
        if (!scheduled) {
          scheduled = true;
          schedule(() => {
            try {
              drain();
            } catch {
              /* never into the caller */
            }
          });
        }
      } catch {
        /* never into the caller */
      }
    },
    async flush(timeoutMs = 2_000) {
      try {
        drain();
        sweep(true);
      } catch {
        /* still wait for what is in flight */
      }
      if (inflight.size === 0) return;
      await Promise.race([
        Promise.allSettled([...inflight]),
        new Promise<void>((resolve) => defaultTimer(resolve, timeoutMs)),
      ]);
    },
  };
}

/* ------------------------------------------------------------ request ids */

/** A caller's request id, echoed only when it is short and boring. */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,100}$/;

/** The request id to report: the one the request carried when it is safe to echo, else a fresh one. */
export function reportableRequestId(raw: unknown, uuid: () => string = defaultUuid): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && SAFE_REQUEST_ID.test(value) ? value : `req_${uuid()}`;
}

/* ----------------------------------------------------------------- hosts */

/** Names that only resolve inside a cluster or a private network. */
const INTERNAL_HOST = /(^|\.)(svc|cluster\.local|local|internal|localdomain|lan)$/;
/**
 * IPv4 ranges that never name a public site: private networks (where pods and
 * nodes answer), link-local, carrier-grade NAT, loopback (a reverse proxy on
 * the same machine forwarding `Host: 127.0.0.1:3000`), and `0.`.
 */
const PRIVATE_IPV4 = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|127\.|0\.)/;

/**
 * A host fit to report as `$host`: the public name a request was addressed
 * to (`app.example.com`, `localhost:3000`), lower-cased, or null. Never an
 * address that only means something inside the deployment's network (a pod
 * or node IP, a cluster service name), and never anything that is not a
 * plain host and port.
 */
export function reportableHost(raw: unknown): string | null {
  const value = (Array.isArray(raw) ? raw[0] : raw) as unknown;
  if (typeof value !== 'string') return null;
  const host = value.trim().toLowerCase();
  if (!/^[a-z0-9.-]{1,253}(:\d{1,5})?$/.test(host)) return null;
  const name = host.replace(/:\d+$/, '');
  if (PRIVATE_IPV4.test(name) || INTERNAL_HOST.test(name)) return null;
  if (!name.includes('.') && name !== 'localhost') return null;
  return host;
}

/** The host of a configured public URL (`PUBLIC_APP_URL`, `API_PUBLIC_URL`), or null. */
export function hostOfUrl(url: string | null | undefined): string | null {
  return reportableHost(/^https?:\/\/([^/?#@]+)/i.exec(url ?? '')?.[1]);
}

/* ------------------------------------------------------------------ wire */

/**
 * One error as the configured provider's capture API takes it: an
 * `$exception` event (the shape its error tracking groups into issues), with
 * no person profile. A server error belongs to no person, so `distinctId`
 * names the reporting process (`calendars-api`, `calendars-web-server`).
 */
export function exceptionEvent(
  report: ErrorReport,
  opts: { distinctId: string; platform?: 'node:javascript' | 'web:javascript' },
): Record<string, unknown> {
  const platform = opts.platform ?? 'node:javascript';
  return {
    event: '$exception',
    distinct_id: opts.distinctId,
    uuid: report.uuid,
    timestamp: new Date(report.timestamp).toISOString(),
    properties: {
      ...report.properties,
      // Every error belongs to this product, whatever a caller passed.
      product: ANALYTICS_PRODUCT,
      count: report.count,
      $exception_level: 'error',
      $exception_list: report.exceptions.map((e, i) => ({
        type: e.type,
        value: e.value,
        mechanism: {
          type: report.mechanism,
          handled: report.handled,
          synthetic: false,
          exception_id: i,
          ...(i > 0 ? { parent_id: i - 1 } : {}),
        },
        stacktrace: { type: 'raw', frames: e.frames.map((f) => ({ platform, ...f })) },
      })),
      $process_person_profile: false,
    },
  };
}

/** The response fields the POST helper reads. */
export interface AnalyticsResponse {
  ok: boolean;
  status: number;
}

/** `fetch`, as much of it as the POST helper uses. */
export type AnalyticsFetch = (
  url: string,
  init: { method: 'POST'; headers: Record<string, string>; body: string; signal?: unknown; redirect?: 'error' },
) => Promise<AnalyticsResponse>;

/** Give up on a hung provider quickly: nobody waits on telemetry. */
export const ANALYTICS_REQUEST_TIMEOUT_MS = 3_000;

/**
 * POST one event to the configured provider's capture endpoint
 * (`<host>/capture/`, authorized by the write-only project key in the body).
 * Resolves with the response; rejects only on a network failure or the
 * timeout. A redirect is refused rather than followed: it would turn the POST
 * into a GET that can only be refused.
 */
export async function sendAnalyticsEvent(
  config: AnalyticsConfig,
  body: Record<string, unknown>,
  fetchImpl?: AnalyticsFetch,
): Promise<AnalyticsResponse> {
  const doFetch = fetchImpl ?? ((globalThis as unknown as { fetch: AnalyticsFetch }).fetch as AnalyticsFetch);
  const abort = (globalThis as unknown as { AbortSignal?: { timeout?: (ms: number) => unknown } }).AbortSignal;
  return doFetch(`${config.host}/capture/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ api_key: config.key, ...body }),
    ...(abort?.timeout ? { signal: abort.timeout(ANALYTICS_REQUEST_TIMEOUT_MS) } : {}),
    redirect: 'error',
  });
}
