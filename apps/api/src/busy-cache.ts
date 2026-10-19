/**
 * A short-lived, per-connection cache of busy reads, for the reads that only
 * DISPLAY availability (the booking page's month, the team page, the manage
 * page's reschedule picker, the host's own new-booking screen, the agent slot
 * reads). Nothing that DECIDES a booking reads through it: holds, bookings,
 * reschedules and confirmations keep reading the calendar fresh through the
 * raw provider (`CalendarEffects.provider`). See ADR 0009.
 *
 * What it does, per connection (one connected calendar, an opaque ref):
 *
 *   - Fresh for `ttlMs` (default 30 s): a read inside that window is answered
 *     from memory. Twenty visitors opening the same page share one vendor read
 *     instead of queueing twenty behind the per-host pacer.
 *   - Single flight: identical reads that arrive while one is already asking
 *     the calendar wait for that one instead of starting their own.
 *   - Stale on error, bounded: when a fresh read fails, or is still running
 *     after `readTimeoutMs`, the connection's last good read stands in if it is
 *     younger than `maxStaleMs` (default 5 min). Older than that, or never
 *     read, the connection's busy is UNKNOWN and the read throws, which every
 *     caller already turns into "calendar unavailable" (fail closed: a time
 *     whose busy state is unknown is never offered).
 *   - Each connection is read, cached and fails on its own: a host with two
 *     calendars keeps the good one's answer when the other one fails.
 *   - Bounded: at most `maxEntries` windows are held, least recently used out
 *     first.
 *
 * It is per process. Several API replicas each hold their own; a booking made
 * on one replica clears that replica's entries (`invalidate`) and the others
 * catch up within `ttlMs`. That is safe because the cache only ever feeds what
 * a page SHOWS, and a booking is always re-checked fresh before it is written.
 *
 * Logs: one line when a stale read is served or a read fails, at most once per
 * minute per connection and event, naming the connection by a short hash.
 * Never a ref, a token, an email or an event.
 */
import { createHash } from 'node:crypto';
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
import { failureCause } from './calendar.http-provider';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface BusyCacheOptions {
  /** How long a read answers display reads without asking the calendar again. */
  ttlMs: number;
  /** How old the last good read may be and still stand in for a failed fresh one. */
  maxStaleMs: number;
  /** The most windows held across every connection; least recently used goes first. */
  maxEntries: number;
  /**
   * How long a display read waits on the calendar before answering from the
   * last good read (or as unknown). The read itself keeps going and fills the
   * cache when it lands, so the next visitor gets it.
   */
  readTimeoutMs: number;
  /**
   * After a read of a connection fails, how long further reads of it answer
   * from what is held instead of asking a calendar that just failed again.
   */
  failureCooldownMs: number;
  /** Clock; injectable for tests. */
  now?: () => number;
  /** Where the rate-limited warning lines go. */
  warn?: (line: string) => void;
  /** At most one line per connection and event in this window. */
  logEveryMs?: number;
}

export const BUSY_CACHE_DEFAULTS = {
  ttlMs: 30_000,
  maxStaleMs: 5 * 60_000,
  maxEntries: 1000,
  readTimeoutMs: 10_000,
  failureCooldownMs: 5_000,
} as const;

/**
 * Thrown when a connection's busy state is unknown: the fresh read failed or
 * ran out of time, and no read young enough to stand in is held. Callers treat
 * it like any failed read (fail closed). The message names counts only.
 */
export class BusyUnknownError extends Error {
  constructor(
    readonly unknown: number,
    readonly connections: number,
  ) {
    super(`busy unknown for ${unknown} of ${connections} connection(s)`);
    this.name = 'BusyUnknownError';
  }
}

interface Span {
  fromMs: number;
  toMs: number;
}

interface Entry extends Span {
  key: string;
  conn: string;
  intervals: BusyInterval[];
  /** When the read that produced this entry STARTED: its age counts from there. */
  fetchedAt: number;
  /** Fresh until this instant; 0 once invalidated (still usable as a stale stand-in). */
  freshUntil: number;
}

interface Flight extends Span {
  key: string;
  conn: string;
  startedAt: number;
  promise: Promise<BusyInterval[]>;
}

/** The read window, widened to whole UTC days so visitors a few minutes apart share it. */
function widen(fromMs: number, toMs: number): Span {
  return { fromMs: Math.floor(fromMs / DAY_MS) * DAY_MS, toMs: Math.ceil(toMs / DAY_MS) * DAY_MS };
}

const contains = (outer: Span, inner: Span): boolean => outer.fromMs <= inner.fromMs && outer.toMs >= inner.toMs;

/** Only the intervals that touch [fromMs, toMs), each once. */
function clip(intervals: BusyInterval[], fromMs: number, toMs: number): BusyInterval[] {
  const out: BusyInterval[] = [];
  const seen = new Set<string>();
  for (const b of intervals) {
    const s = Date.parse(b.startUtc);
    const e = Date.parse(b.endUtc);
    // An interval whose bounds do not parse is kept: dropping it would offer
    // a time the calendar may have said is busy. The engine decides what to
    // make of it, exactly as it would without the cache.
    if (Number.isFinite(s) && Number.isFinite(e) && !(s < toMs && e > fromMs)) continue;
    const id = `${b.startUtc}|${b.endUtc}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ startUtc: b.startUtc, endUtc: b.endUtc });
  }
  return out;
}

/** A connection's name in a log line: short, stable, not reversible to the ref. */
export function connectionTag(ref: string): string {
  return createHash('sha256').update(ref).digest('hex').slice(0, 10);
}

export class BusyCache {
  private readonly opts: Required<Omit<BusyCacheOptions, 'warn'>> & { warn: (line: string) => void };
  /** Every held window, in least-recently-used order (a Map keeps insertion order). */
  private readonly entries = new Map<string, Entry>();
  private readonly entriesByConn = new Map<string, Set<string>>();
  private readonly flights = new Map<string, Flight>();
  private readonly flightsByConn = new Map<string, Set<string>>();
  /** Bumped by `invalidate`: a read that started before the bump is not stored as fresh. */
  private readonly generation = new Map<string, number>();
  private readonly failedAt = new Map<string, number>();
  private readonly lastLog = new Map<string, { at: number; suppressed: number }>();

  constructor(options: BusyCacheOptions) {
    this.opts = {
      ttlMs: Math.max(0, options.ttlMs),
      maxStaleMs: Math.max(0, options.maxStaleMs),
      maxEntries: Math.max(1, Math.floor(options.maxEntries)),
      readTimeoutMs: Math.max(1, options.readTimeoutMs),
      failureCooldownMs: Math.max(0, options.failureCooldownMs),
      now: options.now ?? Date.now,
      warn: options.warn ?? (() => undefined),
      logEveryMs: options.logEveryMs ?? 60_000,
    };
  }

  /** How many windows are held (tests, and nothing else). */
  get size(): number {
    return this.entries.size;
  }

  /**
   * The busy intervals of ONE connection over [fromMs, toMs), from memory when
   * a fresh enough read is held, else from the calendar. Throws
   * `BusyUnknownError` when the calendar cannot answer and nothing young
   * enough stands in.
   */
  async read(
    inner: CalendarProvider,
    ref: string,
    calendarIds: string[] | undefined,
    fromMs: number,
    toMs: number,
  ): Promise<BusyInterval[]> {
    const conn = calendarIds?.length ? `${ref}\u0000${[...calendarIds].sort().join('\u0001')}` : ref;
    const want: Span = { fromMs, toMs };
    const now = this.opts.now();

    const held = this.best(conn, want, now);
    if (held && now < held.freshUntil) {
      this.touch(held);
      return clip(held.intervals, fromMs, toMs);
    }

    // A connection that just failed is not asked again straight away: what is
    // held answers, or nothing does.
    const failed = this.failedAt.get(conn);
    if (failed !== undefined && now - failed < this.opts.failureCooldownMs && !this.flightFor(conn, want)) {
      return this.fallback(ref, conn, want, now, 'cooldown', null);
    }

    const flight = this.flightFor(conn, want) ?? this.start(inner, ref, conn, calendarIds, widen(fromMs, toMs), now);
    // Everyone waiting on one read gives up at the same instant: the read's
    // start plus the timeout, never a fresh timeout per visitor who joined late.
    const wait = Math.max(0, flight.startedAt + this.opts.readTimeoutMs - now);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), wait);
      timer.unref?.();
    });
    try {
      const outcome = await Promise.race([flight.promise.then((intervals) => ({ intervals })), timedOut]);
      if (outcome === 'timeout') return this.fallback(ref, conn, want, this.opts.now(), 'timeout', null);
      return clip(outcome.intervals, fromMs, toMs);
    } catch (err) {
      return this.fallback(ref, conn, want, this.opts.now(), 'error', err);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Forget that these connections' held reads are fresh, after a booking
   * changed what their calendars hold. The reads stay as stand-ins for a
   * failed read (within `maxStaleMs`); a read already in flight is not stored
   * as fresh when it lands, since it may predate the change.
   */
  invalidate(refs: Iterable<string>): void {
    const targets = new Set(refs);
    if (targets.size === 0) return;
    for (const entry of this.entries.values()) {
      if (targets.has(refOf(entry.conn))) entry.freshUntil = 0;
    }
    for (const ref of targets) this.generation.set(ref, (this.generation.get(ref) ?? 0) + 1);
    // Keep the generation map from growing without bound: a ref with nothing
    // held and nothing in flight has nothing a stale generation could affect.
    if (this.generation.size > this.opts.maxEntries * 2) {
      const live = new Set<string>();
      for (const e of this.entries.values()) live.add(refOf(e.conn));
      for (const f of this.flights.values()) live.add(refOf(f.conn));
      for (const ref of this.generation.keys()) if (!live.has(ref)) this.generation.delete(ref);
    }
  }

  // --- internals ------------------------------------------------------------

  /**
   * The best held window of `conn` that covers `want`: a fresh one first, else
   * the most recently read. Windows too old to be of any use are dropped here.
   */
  private best(conn: string, want: Span, now: number): Entry | undefined {
    let pick: Entry | undefined;
    const rank = (e: Entry): [number, number] => [now < e.freshUntil ? 1 : 0, e.fetchedAt];
    for (const key of [...(this.entriesByConn.get(conn) ?? [])]) {
      const e = this.entries.get(key);
      if (!e) continue;
      if (now - e.fetchedAt > Math.max(this.opts.maxStaleMs, this.opts.ttlMs)) {
        this.drop(e);
        continue;
      }
      if (!contains(e, want)) continue;
      if (!pick) {
        pick = e;
        continue;
      }
      const [ef, et] = rank(e);
      const [pf, pt] = rank(pick);
      if (ef > pf || (ef === pf && et > pt)) pick = e;
    }
    return pick;
  }

  private flightFor(conn: string, want: Span): Flight | undefined {
    for (const key of this.flightsByConn.get(conn) ?? []) {
      const f = this.flights.get(key);
      if (f && contains(f, want)) return f;
    }
    return undefined;
  }

  private start(
    inner: CalendarProvider,
    ref: string,
    conn: string,
    calendarIds: string[] | undefined,
    span: Span,
    now: number,
  ): Flight {
    const key = `${conn}\u0000${span.fromMs}\u0000${span.toMs}`;
    const gen = this.generation.get(ref) ?? 0;
    const promise = inner
      .listBusy({
        connectionRefs: [ref],
        ...(calendarIds?.length ? { calendarIds } : {}),
        fromUtc: new Date(span.fromMs).toISOString(),
        toUtc: new Date(span.toMs).toISOString(),
      })
      .then(
        (intervals) => {
          this.failedAt.delete(conn);
          this.store({
            key,
            conn,
            fromMs: span.fromMs,
            toMs: span.toMs,
            intervals: clip(intervals, span.fromMs, span.toMs),
            fetchedAt: now,
            // A read that began before an invalidation reflects the calendar
            // as it was: held as a stand-in, never as fresh.
            freshUntil: (this.generation.get(ref) ?? 0) === gen ? now + this.opts.ttlMs : 0,
          });
          return intervals;
        },
        (err: unknown) => {
          // Bounded like everything else here: a connection that failed long
          // ago and was never read again has nothing left to cool down.
          if (this.failedAt.size > this.opts.maxEntries * 2) {
            const cutoff = this.opts.now() - this.opts.failureCooldownMs;
            for (const [key, at] of this.failedAt) if (at < cutoff) this.failedAt.delete(key);
          }
          this.failedAt.set(conn, this.opts.now());
          throw err;
        },
      )
      .finally(() => {
        this.flights.delete(key);
        const set = this.flightsByConn.get(conn);
        set?.delete(key);
        if (set && set.size === 0) this.flightsByConn.delete(conn);
      });
    // Nobody may be left holding an unhandled rejection: a read whose every
    // waiter gave up on time still settles.
    promise.catch(() => undefined);
    const flight: Flight = { key, conn, fromMs: span.fromMs, toMs: span.toMs, startedAt: now, promise };
    this.flights.set(key, flight);
    let set = this.flightsByConn.get(conn);
    if (!set) this.flightsByConn.set(conn, (set = new Set()));
    set.add(key);
    return flight;
  }

  private store(entry: Entry): void {
    const existing = this.entries.get(entry.key);
    if (existing) this.drop(existing);
    this.entries.set(entry.key, entry);
    let set = this.entriesByConn.get(entry.conn);
    if (!set) this.entriesByConn.set(entry.conn, (set = new Set()));
    set.add(entry.key);
    while (this.entries.size > this.opts.maxEntries) {
      const oldest = this.entries.values().next().value as Entry | undefined;
      if (!oldest) break;
      this.drop(oldest);
    }
  }

  private touch(entry: Entry): void {
    this.entries.delete(entry.key);
    this.entries.set(entry.key, entry);
  }

  private drop(entry: Entry): void {
    this.entries.delete(entry.key);
    const set = this.entriesByConn.get(entry.conn);
    set?.delete(entry.key);
    if (set && set.size === 0) this.entriesByConn.delete(entry.conn);
  }

  /** The last good read when it is young enough, else unknown (throws). */
  private fallback(
    ref: string,
    conn: string,
    want: Span,
    now: number,
    reason: 'timeout' | 'error' | 'cooldown',
    err: unknown,
  ): BusyInterval[] {
    const held = this.best(conn, want, now);
    const cause = err === null ? '' : ` ${failureCause(err)}`;
    if (held && now - held.fetchedAt <= this.opts.maxStaleMs) {
      this.touch(held);
      this.report('stale_served', ref, `age_ms=${now - held.fetchedAt} reason=${reason}${cause}`);
      return clip(held.intervals, want.fromMs, want.toMs);
    }
    this.report('read_failed', ref, `reason=${reason}${cause} stand_in=none busy=unknown`);
    throw new BusyUnknownError(1, 1);
  }

  private report(event: string, ref: string, detail: string): void {
    const tag = connectionTag(ref);
    const key = `${event}\u0000${tag}`;
    const now = this.opts.now();
    const last = this.lastLog.get(key);
    if (last && now - last.at < this.opts.logEveryMs) {
      last.suppressed += 1;
      return;
    }
    if (this.lastLog.size > 1000) this.lastLog.clear();
    const suppressed = last?.suppressed ?? 0;
    this.lastLog.set(key, { at: now, suppressed: 0 });
    this.opts.warn(`busy cache: event=${event} conn=${tag} ${detail} suppressed=${suppressed}`);
  }
}

/** The ref a cache key belongs to (a key with calendar ids appends them after a NUL). */
function refOf(conn: string): string {
  const cut = conn.indexOf('\u0000');
  return cut === -1 ? conn : conn.slice(0, cut);
}

/**
 * A CalendarProvider that answers `listBusy` through a `BusyCache`, one
 * connection at a time, and hands everything else straight to the provider it
 * wraps. Used ONLY for display reads; see the file header.
 */
export class CachedBusyProvider implements CalendarProvider {
  constructor(
    private readonly inner: CalendarProvider,
    private readonly cache: BusyCache,
  ) {}

  get enabled(): boolean {
    return this.inner.enabled;
  }

  get conferencingLabel(): string | null {
    return this.inner.conferencingLabel ?? null;
  }

  async listBusy(input: ListBusyInput): Promise<BusyInterval[]> {
    const fromMs = Date.parse(input.fromUtc);
    const toMs = Date.parse(input.toUtc);
    // Anything the cache cannot reason about goes to the provider as it came.
    if (!this.inner.enabled || input.connectionRefs.length === 0 || !(toMs > fromMs)) {
      return this.inner.listBusy(input);
    }
    const refs = [...new Set(input.connectionRefs)];
    const reads = await Promise.allSettled(
      refs.map((ref) => this.cache.read(this.inner, ref, input.calendarIds, fromMs, toMs)),
    );
    const unknown = reads.filter((r) => r.status === 'rejected').length;
    // One connection whose busy is unknown makes the HOST's busy unknown: a
    // time free on the calendar we could read may be taken on the one we could
    // not. The caller withholds the times (fail closed), as before.
    if (unknown > 0) throw new BusyUnknownError(unknown, refs.length);
    const merged: BusyInterval[] = [];
    for (const r of reads) if (r.status === 'fulfilled') merged.push(...r.value);
    return clip(merged, fromMs, toMs);
  }

  createEvent(input: CreateEventInput): Promise<CreatedEvent> {
    return this.inner.createEvent(input);
  }

  updateEvent(input: UpdateEventInput): Promise<CreatedEvent> {
    return this.inner.updateEvent(input);
  }

  deleteEvent(input: DeleteEventInput): Promise<void> {
    return this.inner.deleteEvent(input);
  }

  listCalendars(connectionRef: string): Promise<CalendarSummary[]> {
    return this.inner.listCalendars(connectionRef);
  }

  checkConnection(connectionRef: string): Promise<ConnectionHealth> {
    return this.inner.checkConnection(connectionRef);
  }
}
