'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BookingField, Slot } from '@slate/types';
import {
  addSpan,
  bookingHorizonMs,
  covers,
  missingSpans,
  monthWindow,
  type Span,
} from '@/lib/availability-window';
import { availabilityUrl, type AvailabilityChunk, type AvailabilitySource } from '@/lib/availability-source';

/**
 * A booking page's availability, read the month on screen first.
 *
 * `initial` is the visible month's read, started by the server before it
 * renders and streamed in with the page, so the page paints without waiting on
 * a calendar. `window` is the span it answers.
 */
export interface ProgressiveAvailability {
  initial: Promise<AvailabilityChunk>;
  window: { from: string; to: string };
  source: AvailabilitySource;
}

/**
 * How long to wait before asking again for a window that did not answer, one
 * entry per retry: a blip clears within seconds, and an outage is asked five
 * times over half a minute rather than hammered. After the last, the window
 * stays "not yet known" until the visitor goes to it again. Each wait is
 * jittered (`retryDelay`), so the pages one blip hit do not all ask again at
 * the same instant.
 */
export const RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 16_000];

/** The wait before retry `attempt`, spread over half to one and a half times its base. */
export function retryDelay(attempt: number, random: () => number = Math.random): number | undefined {
  const base = RETRY_DELAYS_MS[attempt];
  return base === undefined ? undefined : Math.round(base * (0.5 + random()));
}

/** Fetches one later window; injectable so specs can watch the order. */
export type WindowLoader = (source: AvailabilitySource, span: Span) => Promise<AvailabilityChunk>;

const fetchWindow: WindowLoader = async (source, span) => {
  try {
    const res = await fetch(availabilityUrl(source, span), { cache: 'no-store' });
    if (res.ok) return (await res.json()) as AvailabilityChunk;
    return res.status === 400 || res.status === 404 ? { ok: false, final: true } : { ok: false };
  } catch {
    return { ok: false };
  }
};

interface State {
  /** Every time read so far, in start order, once each. */
  slots: Slot[];
  /** The spans read and answered. */
  known: Span[];
  /** A configuration reason the event offers nothing (it holds for every window). */
  emptyReason?: string;
  /** A read did not answer before any time was known: the page says so. */
  unavailable: boolean;
  bookingFields?: BookingField[];
}

function mergeSlots(a: Slot[], b: Slot[]): Slot[] {
  if (b.length === 0) return a;
  const byStart = new Map(a.map((s) => [s.startUtc, s]));
  for (const s of b) byStart.set(s.startUtc, s);
  return [...byStart.values()].sort((x, y) => (x.startUtc < y.startUtc ? -1 : x.startUtc > y.startUtc ? 1 : 0));
}

/**
 * The times a booking page has, and which months it can vouch for.
 *
 * With `staticSlots` (the studio's preview, the one-off link page) everything
 * is known from the first render and nothing is fetched. With `availability`
 * the page starts knowing nothing, receives the visible month, then reads the
 * next month as soon as the one on screen settles, and any other month when the
 * visitor goes to it (or points at the arrow that goes there). A month whose
 * read failed stays "not yet known", is asked again on its own after a short
 * backoff (`RETRY_DELAYS_MS`; never a request the route refused as such) and
 * again whenever the visitor comes to it, so a page never claims a month has
 * no times when it simply does not know, and a passing failure does not
 * strand the visitor.
 */
export function useProgressiveSlots({
  staticSlots,
  availability,
  nowUtc,
  loader = fetchWindow,
}: {
  staticSlots?: Slot[];
  availability?: ProgressiveAvailability;
  nowUtc: string;
  loader?: WindowLoader;
}) {
  const nowMs = Date.parse(nowUtc);
  const horizonMs = bookingHorizonMs(nowMs);
  const progressive = !!availability;
  const whole: Span = useMemo(() => ({ fromMs: nowMs, toMs: horizonMs }), [nowMs, horizonMs]);

  const [state, setState] = useState<State>(() => ({
    slots: staticSlots ?? [],
    known: progressive ? [] : [whole],
    unavailable: false,
  }));
  // Spans asked for and not yet answered, so two quick moves never read one
  // window twice. A ref: it gates fetching and is never rendered. Each read is
  // its own entry, never merged with a neighbour: an answer removes exactly the
  // span it answers, so two adjacent reads in flight cannot leave a merged span
  // behind that claims a failed month is still being read.
  const inflight = useRef<Span[]>([]);
  const alive = useRef(true);
  // The retry waiting for each span, at most one: a span's retries are one
  // chain however many reads of it fail (a visit, the month effect re-running).
  // Keyed by the exact span, so a read shaped differently (another time zone's
  // month) is its own chain; each chain is still bounded.
  const waiting = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    alive.current = true;
    const pending = waiting.current;
    return () => {
      alive.current = false;
      for (const t of pending.values()) clearTimeout(t);
      pending.clear();
    };
  }, []);

  // What a retry reads when its timer fires, kept current after each render:
  // a retry asks with what the page knows THEN, and with the current source
  // and loader, not the ones of the render that scheduled it.
  const knownNow = useRef<Span[]>(state.known);
  const fetchNow = useRef<(want: Span, known: Span[], attempt: number) => Promise<void>>(async () => {});

  // A window that did not answer is asked again on its own, after a backoff
  // and a bounded number of times. Without it nothing asked again unless the
  // visitor moved: a failed visible month left the "times unavailable" sentence
  // in place of the calendar for good, and a failed month on screen stayed
  // unsettled. It reads only refs, so it is made once.
  const retryLater = useRef((span: Span, attempt: number) => {
    const key = `${span.fromMs}:${span.toMs}`;
    const delay = retryDelay(attempt);
    if (delay === undefined || waiting.current.has(key)) return;
    const timer = setTimeout(() => {
      waiting.current.delete(key);
      if (alive.current) void fetchNow.current(span, knownNow.current, attempt + 1);
    }, delay);
    waiting.current.set(key, timer);
  });
  const apply = useCallback((span: Span, chunk: AvailabilityChunk, attempt = 0) => {
    inflight.current = inflight.current.filter((s) => s.fromMs !== span.fromMs || s.toMs !== span.toMs);
    if (!alive.current) return;
    const failed = !chunk.ok || chunk.emptyReason === 'CALENDAR_UNAVAILABLE';
    if (failed && !(!chunk.ok && chunk.final)) retryLater.current(span, attempt);
    setState((s) => {
      // A window that could not be read is not a window with no times. Only
      // when nothing at all has been read does the page say so; once any
      // window has answered (even with no times), the failed one just stays
      // "not yet known". Either way it is asked again (`retryLater` above), and
      // the first window that answers takes the sentence back.
      if (!chunk.ok || chunk.emptyReason === 'CALENDAR_UNAVAILABLE') {
        return s.known.length === 0 ? { ...s, unavailable: true } : s;
      }
      // A configuration reason (no schedule, no hours) holds for every window.
      // It is an answer, so it also takes back an earlier "unavailable": a
      // visible month that failed and then answered on a retry says the real
      // reason, not that the times are temporarily unavailable.
      if (chunk.emptyReason) {
        return {
          ...s,
          emptyReason: chunk.emptyReason,
          known: [whole],
          unavailable: false,
          bookingFields: s.bookingFields ?? chunk.bookingFields,
        };
      }
      return {
        slots: mergeSlots(s.slots, chunk.slots),
        known: addSpan(s.known, span),
        // A later window answering clears an earlier one that did not.
        unavailable: false,
        emptyReason: s.emptyReason,
        bookingFields: s.bookingFields ?? chunk.bookingFields,
      };
    });
  }, [whole]);

  // The visible month, already in flight from the server.
  const initial = availability?.initial;
  const initialFrom = availability?.window.from;
  const initialTo = availability?.window.to;
  useEffect(() => {
    if (!initial || !initialFrom || !initialTo) return;
    const span = { fromMs: Date.parse(initialFrom), toMs: Date.parse(initialTo) };
    inflight.current = [...inflight.current, span];
    initial.then(
      (chunk) => apply(span, chunk),
      () => apply(span, { ok: false }),
    );
  }, [initial, initialFrom, initialTo, apply]);

  const source = availability?.source;
  /**
   * Read the pieces of `want` neither known nor in flight; `attempt` counts
   * retries. Settles once those reads have answered (and been applied).
   */
  const fetchMissing = useCallback(
    async (want: Span, known: Span[], attempt = 0) => {
      if (!source) return;
      const have = inflight.current.reduce(addSpan, known);
      const reads: Promise<void>[] = [];
      for (const gap of missingSpans(have, want)) {
        inflight.current = [...inflight.current, gap];
        reads.push(loader(source, gap).then((chunk) => apply(gap, chunk, attempt)));
      }
      await Promise.all(reads);
    },
    [source, loader, apply],
  );
  useEffect(() => {
    knownNow.current = state.known;
    fetchNow.current = fetchMissing;
  }, [state.known, fetchMissing]);

  /**
   * Read whatever of `monthKey` (in `timeZone`) the page does not have yet.
   * Settles when those reads have answered; nothing to read settles at once.
   */
  const ensureMonth = useCallback(
    (monthKey: string, timeZone: string): Promise<void> => {
      const w = monthWindow(monthKey, timeZone, nowMs, horizonMs);
      return w ? fetchMissing(w, state.known) : Promise.resolve();
    },
    [fetchMissing, state.known, nowMs, horizonMs],
  );

  /** True when every bookable instant of `monthKey` has been read. */
  const isKnown = useCallback(
    (monthKey: string, timeZone: string) => {
      const w = monthWindow(monthKey, timeZone, nowMs, horizonMs);
      return !w || covers(state.known, w);
    },
    [state.known, nowMs, horizonMs],
  );

  const everythingKnown = covers(state.known, whole);

  return {
    progressive,
    slots: state.slots,
    emptyReason: state.emptyReason,
    unavailable: state.unavailable,
    bookingFields: state.bookingFields,
    everythingKnown,
    isKnown,
    ensureMonth,
    horizonMs,
  };
}
