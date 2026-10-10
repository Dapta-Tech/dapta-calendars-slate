/**
 * The concrete `external` CalendarProvider: a GENERIC HTTP adapter. It performs
 * only vendor-neutral orchestration — mint a bearer, send JSON, map non-2xx to a
 * thrown error (so the outbox retries), enforce a timeout — and delegates ALL
 * request/response SHAPING to a pluggable `CalendarWire`, and all auth to a
 * pluggable `CalendarTokenSource`.
 *
 * R15: nothing here names a vendor, a host, or a key structure. `connectionRef`
 * is treated as an OPAQUE string end-to-end; only a wire knows how to interpret
 * it. The committed default (`GenericRestWire` + `StaticTokenSource`) speaks a
 * clean REST contract any self-hoster can implement. A PRIVATE overlay module
 * (loaded by env, see `calendar.provider.ts`) swaps in the real vendor wire +
 * JWT authority without touching this file or the public build.
 */
import { Logger } from '@nestjs/common';
import type {
  BusyInterval,
  CalendarProvider,
  CalendarSummary,
  ConnectionHealth,
  CreateEventInput,
  CreatedEvent,
  DeleteEventInput,
  ListBusyInput,
  UpdateEventInput,
} from '@slate/calendar';

/** Sent on every backend HTTP call — a UA-less request is rejected by the
 *  backend's WAF (403 "error code: 1010"). Mozilla-prefixed to pass generic
 *  bot heuristics; identifies the product for the vendor's request logs. */
const USER_AGENT = 'Mozilla/5.0 (compatible; DaptaCalendars/1.0; +https://calendar.dapta.ai)';

/**
 * The longest span asked of the backend in ONE busy read.
 *
 * A busy read is only as complete as the backend's answer, and many calendar
 * APIs answer an event listing one PAGE at a time. A wire that speaks a
 * single-request contract reads the first page and nothing after it, so past a
 * certain number of events the list comes back short — silently, with a 200.
 * Every event that fell off is a slot offered as free on a calendar that is
 * busy, and the create-time check (which reads only the slot it is about to
 * book, so its page is never full) then refuses it: the visitor picks a time
 * and is told it was just taken.
 *
 * The booking page reads the whole availability window in one go, which is the
 * read most exposed to this. So a long read is cut into windows short enough
 * that one page holds them, and the pieces are unioned. Two weeks sits inside
 * the three a very full calendar has been seen to survive intact, and keeps a
 * 60-day read to five requests: the backend's rate limit is per second (see
 * BUSY_REQUESTS_PER_SECOND), so every window is a second of a visitor's wait.
 */
const BUSY_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * How many busy windows are in flight at once, across every read this provider
 * is serving, on every connection. Held by one semaphore per provider instance,
 * not per call: two visitors opening the same booking page at once share it.
 */
const BUSY_CONCURRENCY = 4;

/**
 * How many busy requests may START within any one second for one subject (the
 * host whose calendar is being read).
 *
 * Measured on the live backend (2026-10-10), in its own words: "Rate limit
 * exceeded: 5 apiRequestsPerCustomerPerSecond", retry after one second. Four
 * leaves one in hand for the host's other traffic. Held per provider instance
 * and per subject, so concurrent reads of one host pace each other and reads
 * of different hosts do not.
 */
const BUSY_REQUESTS_PER_SECOND = 4;

/**
 * A window whose read fails with a status that is about the moment (throttled,
 * backend error, no response) is asked again, up to this many attempts in all,
 * pausing for the backend's own Retry-After when it sends one and for a second
 * per attempt when it does not. Any other status is the backend's answer and
 * is not asked again.
 */
const BUSY_ATTEMPTS = 3;
const BUSY_RETRY_AFTER_MS = 1000;
const retryable = (err: unknown): boolean =>
  err instanceof CalendarHttpError && (err.status === 0 || err.status === 429 || err.status >= 500);

/** Time, as the provider sees it. Injectable so tests need not wait real seconds. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}
const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Per-subject pacing: at most `perSecond` starts in any rolling second. */
class Pacer {
  private readonly starts = new Map<string, number[]>();
  constructor(
    private readonly perSecond: number,
    private readonly clock: Clock,
  ) {}
  async wait(subject: string): Promise<void> {
    for (;;) {
      const now = this.clock.now();
      const recent = (this.starts.get(subject) ?? []).filter((t) => now - t < 1000);
      if (recent.length < this.perSecond) {
        recent.push(now);
        this.starts.set(subject, recent);
        return;
      }
      // The oldest start in the window ages out first; wake just after it does.
      await this.clock.sleep(recent[0]! + 1000 - now + 1);
    }
  }
}

/** A counting semaphore: `acquire` resolves to the function that releases the slot. */
class Slots {
  private free: number;
  private readonly waiting: Array<() => void> = [];
  constructor(size: number) {
    this.free = size;
  }
  acquire(): Promise<() => void> {
    return new Promise((resolve) => {
      const grant = (): void => {
        this.free--;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.free++;
          this.waiting.shift()?.();
        });
      };
      if (this.free > 0) grant();
      else this.waiting.push(grant);
    });
  }
}


/**
 * Cut [fromMs, toMs) into consecutive windows of at most `spanMs`. The windows
 * tile the range exactly: each starts where the previous one ended, so an event
 * on a boundary is always inside at least one of them.
 */
export function splitBusyWindow(fromMs: number, toMs: number, spanMs: number): Array<[number, number]> {
  // A range that is empty, inverted or unparseable is passed through untouched:
  // what the backend makes of it is the backend's answer, as it was before.
  if (!(toMs > fromMs) || !(spanMs > 0)) return [[fromMs, toMs]];
  const windows: Array<[number, number]> = [];
  for (let start = fromMs; start < toMs; start += spanMs) {
    windows.push([start, Math.min(start + spanMs, toMs)]);
  }
  return windows;
}

/** Token authority for the calendar backend. Mints a short-lived bearer. */
export interface CalendarTokenSource {
  /**
   * @param scope   'tenant' for per-account calendar ops, 'admin' for
   *                workspace-level ops (e.g. starting a connect flow).
   * @param subject opaque tenant/connection subject the token is scoped to
   *                (a connectionRef for tenant ops, or a host tenant key for
   *                connect). Ignored by simple static sources.
   */
  mint(scope: 'tenant' | 'admin', subject?: string): Promise<string>;
}

/** The result of starting a connect flow (returned to the browser). */
export interface ConnectStart {
  token: string;
  connectUrl: string;
}

/**
 * A connection the backend reports for a tenant after an OAuth popup completes.
 * `connectionRef` is opaque — it is stored verbatim and later round-tripped to
 * `listCalendars`/`checkConnection`.
 *
 * The last five fields are the vendor's own bookkeeping for THIS connection
 * (not persisted in our schema — merged in per-discover-call only). They exist
 * so the frontend can detect a completed RECONNECT of an ALREADY-linked
 * account: a reconnect reuses the same `connectionRef`/`connectionId`, so a
 * naive "is this connectionRef new" check can never see it complete. Comparing
 * `updatedAt`/`lastActiveAt` against a timestamp captured when the connect
 * popup opened is what actually detects it.
 */
export interface DiscoveredConnection {
  connectionRef: string;
  provider: string;
  primaryEmail?: string | null;
  /** The connected account's profile photo, when the backend reports one. */
  avatarUrl?: string | null;
  name?: string | null;
  /** The vendor's own connection id (may equal connectionRef; kept distinct
   *  in case a wire ever needs to encode connectionRef differently). */
  connectionId?: string;
  connected?: boolean;
  state?: string;
  updatedAt?: string | null;
  lastActiveAt?: string | null;
}

/** A single HTTP call the adapter should make on the wire's behalf. */
export interface WireRequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** Path appended to the backend base URL (may be absolute). */
  path: string;
  body?: unknown;
  scope: 'tenant' | 'admin';
  /** Opaque subject for token minting (connectionRef, or tenant key on connect). */
  subject?: string;
}

/**
 * The shaping seam: builds the request for each calendar operation and parses
 * the backend's response. Everything vendor-specific (paths, action keys, body
 * casing, response envelopes, integrationKey mapping) lives behind this — so the
 * adapter above stays generic and the private overlay is a single drop-in.
 */
export interface CalendarWire {
  listBusy(input: ListBusyInput): WireRequest;
  parseBusy(raw: unknown): BusyInterval[];
  createEvent(input: CreateEventInput): WireRequest;
  updateEvent(input: UpdateEventInput): WireRequest;
  parseEvent(raw: unknown): CreatedEvent;
  deleteEvent(input: DeleteEventInput): WireRequest;
  listCalendars(connectionRef: string): WireRequest;
  /** `connectionRef` is passed back so a wire can re-encode opaque calendar refs. */
  parseCalendars(raw: unknown, connectionRef: string): CalendarSummary[];
  checkConnection(connectionRef: string): WireRequest;
  parseHealth(raw: unknown): ConnectionHealth;
  startConnect(provider: string, tenantKey: string): WireRequest;
  parseConnectStart(raw: unknown, token: string): ConnectStart;
  discoverConnections(tenantKey: string, provider: string): WireRequest;
  /** tenantKey/provider are passed back so a wire can build stable opaque refs. */
  parseDiscovered(raw: unknown, tenantKey: string, provider: string): DiscoveredConnection[];
}

/**
 * The connect-flow capability (used by the connections API, not the booking
 * engine). A provider that supports OAuth connect implements this in addition to
 * `CalendarProvider`; the disabled OSS default does not.
 */
export interface CalendarConnector {
  startConnect(provider: string, tenantKey: string): Promise<ConnectStart>;
  discoverConnections(tenantKey: string, provider: string): Promise<DiscoveredConnection[]>;
}

/** Narrow a provider to a connect-capable one, or null when connect is unsupported. */
export function asConnector(p: CalendarProvider): CalendarConnector | null {
  const c = p as unknown as Partial<CalendarConnector>;
  return typeof c.startConnect === 'function' && typeof c.discoverConnections === 'function'
    ? (c as unknown as CalendarConnector)
    : null;
}

/** A Retry-After header, as ms to wait: seconds, or an HTTP date. Null when absent or unreadable. */
function retryAfterMs(res: Response): number | null {
  const raw = res.headers?.get?.('retry-after');
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

/** Thrown on any non-2xx backend response so the outbox worker retries. */
export class CalendarHttpError extends Error {
  constructor(
    readonly status: number,
    readonly op: string,
    detail: string,
    /** The backend's Retry-After, in ms, when it sent one. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(`calendar backend ${op} failed (${status}): ${detail}`);
    this.name = 'CalendarHttpError';
  }
}

export interface ExternalCalendarOptions {
  baseUrl: string;
  tokenSource: CalendarTokenSource;
  wire: CalendarWire;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Longest span of one busy read, in ms. Defaults to a week. */
  busyWindowMs?: number;
  /** Injectable for tests; defaults to real time. */
  clock?: Clock;
  /**
   * Optional custom connect handshake. Some backends need a multi-step dance
   * (create a request, resolve the end-provider's OAuth URL, …) that the
   * single-request wire contract can't express; when present this replaces
   * `wire.startConnect` so the user lands STRAIGHT on the end provider's
   * consent screen instead of an intermediate hosted page.
   */
  startConnect?: (provider: string, tenantKey: string) => Promise<ConnectStart>;
  /** Display name for the conferencing this backend mints (deploy config). */
  conferencingLabel?: string | null;
}

export class ExternalCalendarProvider implements CalendarProvider {
  readonly enabled = true;
  readonly conferencingLabel: string | null;
  private readonly baseUrl: string;
  private readonly tokens: CalendarTokenSource;
  private readonly wire: CalendarWire;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly busyWindowMs: number;
  private readonly busySlots = new Slots(BUSY_CONCURRENCY);
  private readonly clock: Clock;
  private readonly pacer: Pacer;
  private readonly logger = new Logger(ExternalCalendarProvider.name);
  private readonly startConnectOverride?: ExternalCalendarOptions['startConnect'];

  constructor(opts: ExternalCalendarOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.tokens = opts.tokenSource;
    this.wire = opts.wire;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.busyWindowMs = opts.busyWindowMs ?? BUSY_WINDOW_MS;
    this.clock = opts.clock ?? realClock;
    this.pacer = new Pacer(BUSY_REQUESTS_PER_SECOND, this.clock);
    this.startConnectOverride = opts.startConnect;
    this.conferencingLabel = opts.conferencingLabel ?? null;
  }

  async listBusy(input: ListBusyInput): Promise<BusyInterval[]> {
    if (input.connectionRefs.length === 0) return [];
    const fromMs = Date.parse(input.fromUtc);
    const toMs = Date.parse(input.toUtc);
    // An unparseable bound is sent as given, in one read — never rewritten.
    const windows: Array<{ fromUtc: string; toUtc: string }> =
      Number.isFinite(fromMs) && Number.isFinite(toMs)
        ? splitBusyWindow(fromMs, toMs, this.busyWindowMs).map(([a, b]) => ({
            fromUtc: new Date(a).toISOString(),
            toUtc: new Date(b).toISOString(),
          }))
        : [{ fromUtc: input.fromUtc, toUtc: input.toUtc }];

    // Per-connection reads, merged: a backend need not offer a batch free-busy
    // (many calendar APIs expose only per-calendar event listing). Each
    // connection is read one window at a time (see BUSY_WINDOW_MS).
    // One failed window fails the whole read: a partial busy list is exactly
    // the short answer this exists to prevent, and callers already treat a
    // throw as "calendar unreadable" (fail-closed). `failed` is shared so the
    // other windows of this read stop asking once one is lost.
    let failed = false;
    const sendWindow = async (req: WireRequest): Promise<unknown> => {
      const release = await this.busySlots.acquire();
      try {
        await this.pacer.wait(req.subject ?? '');
        return await this.send('listBusy', req);
      } finally {
        release();
      }
    };
    const reads: Array<() => Promise<BusyInterval[]>> = [];
    for (const ref of input.connectionRefs) {
      for (const window of windows) {
        reads.push(async () => {
          const req = this.wire.listBusy({
            connectionRefs: [ref],
            calendarIds: input.calendarIds,
            fromUtc: window.fromUtc,
            toUtc: window.toUtc,
          });
          for (let attempt = 1; ; attempt++) {
            try {
              return this.wire.parseBusy(await sendWindow(req));
            } catch (err) {
              if (!retryable(err) || attempt >= BUSY_ATTEMPTS || failed) throw err;
              // The slot is already released: the pause costs nobody else a read.
              const pause = (err as CalendarHttpError).retryAfterMs ?? BUSY_RETRY_AFTER_MS * attempt;
              await this.clock.sleep(pause);
              if (failed) throw err; // a sibling window was lost meanwhile: this read is over
            }
          }
        });
      }
    }

    // A pool in request order. The semaphore above is the real ceiling and it
    // is shared across reads; this pool only keeps one read from queueing all
    // of its windows at once behind it.
    const results: BusyInterval[][] = new Array(reads.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (!failed && next < reads.length) {
        const i = next++;
        try {
          results[i] = await reads[i]!();
        } catch (err) {
          failed = true;
          // The caller turns this into "calendar unavailable" and keeps the
          // cause to itself; this line is the only record of WHICH window and
          // WHY, and it is what made the concurrency limit above visible.
          this.logger.warn(`busy read failed: ${err instanceof Error ? err.message : String(err)}`);
          throw err;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(BUSY_CONCURRENCY, reads.length) }, worker));

    // An event that crosses a window boundary is reported by both windows. The
    // engine merges busy itself, so the duplicate is harmless — but a caller
    // that counts intervals should not see one event twice.
    const seen = new Set<string>();
    const out: BusyInterval[] = [];
    for (const interval of results.flat()) {
      const key = `${interval.startUtc}|${interval.endUtc}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(interval);
    }
    return out;
  }

  async createEvent(input: CreateEventInput): Promise<CreatedEvent> {
    return this.wire.parseEvent(await this.send('createEvent', this.wire.createEvent(input)));
  }

  async updateEvent(input: UpdateEventInput): Promise<CreatedEvent> {
    return this.wire.parseEvent(await this.send('updateEvent', this.wire.updateEvent(input)));
  }

  async deleteEvent(input: DeleteEventInput): Promise<void> {
    await this.send('deleteEvent', this.wire.deleteEvent(input));
  }

  async listCalendars(connectionRef: string): Promise<CalendarSummary[]> {
    return this.wire.parseCalendars(
      await this.send('listCalendars', this.wire.listCalendars(connectionRef)),
      connectionRef,
    );
  }

  async checkConnection(connectionRef: string): Promise<ConnectionHealth> {
    // Health is diagnostic: never throw — a dead connection is a valid answer.
    try {
      return this.wire.parseHealth(
        await this.send('checkConnection', this.wire.checkConnection(connectionRef)),
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { ok: false, detail };
    }
  }

  /** Start a connect flow (used by the connections API, not the booking engine). */
  async startConnect(provider: string, tenantKey: string): Promise<ConnectStart> {
    if (this.startConnectOverride) return this.startConnectOverride(provider, tenantKey);
    const req = this.wire.startConnect(provider, tenantKey);
    const token = await this.tokens.mint(req.scope, req.subject);
    const raw = await this.send('startConnect', req, token);
    return this.wire.parseConnectStart(raw, token);
  }

  /** List the tenant's connections after a popup completes (to register them). */
  async discoverConnections(tenantKey: string, provider: string): Promise<DiscoveredConnection[]> {
    return this.wire.parseDiscovered(
      await this.send('discoverConnections', this.wire.discoverConnections(tenantKey, provider)),
      tenantKey,
      provider,
    );
  }

  /** Generic HTTP: auth + JSON + timeout + non-2xx→throw. Returns parsed JSON. */
  private async send(op: string, req: WireRequest, presetToken?: string): Promise<unknown> {
    const token = presetToken ?? (await this.tokens.mint(req.scope, req.subject));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${req.path}`, {
        method: req.method,
        headers: {
          authorization: `Bearer ${token}`,
          // A User-Agent is REQUIRED: the calendar backend sits behind a WAF that
          // rejects UA-less requests (server-side fetch/undici sends none by
          // default) with 403 "error code: 1010". Without this the busy-fetch
          // fails → availability fails closed (CALENDAR_UNAVAILABLE) → no slots.
          'user-agent': USER_AGENT,
          ...(req.body != null ? { 'content-type': 'application/json' } : {}),
        },
        body: req.body != null ? JSON.stringify(req.body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new CalendarHttpError(0, op, detail);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    if (!res.ok) throw new CalendarHttpError(res.status, op, text.slice(0, 500), retryAfterMs(res));
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new CalendarHttpError(res.status, op, `non-JSON body: ${text.slice(0, 200)}`);
    }
  }
}
