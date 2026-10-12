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

/** Fetches one later window; injectable so specs can watch the order. */
export type WindowLoader = (source: AvailabilitySource, span: Span) => Promise<AvailabilityChunk>;

const fetchWindow: WindowLoader = async (source, span) => {
  try {
    const res = await fetch(availabilityUrl(source, span), { cache: 'no-store' });
    return res.ok ? ((await res.json()) as AvailabilityChunk) : { ok: false };
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
 * read failed stays "not yet known" and is asked again the next time the
 * visitor comes to it, so a page never claims a month has no times when it
 * simply does not know.
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
  // window twice. A ref: it gates fetching and is never rendered.
  const inflight = useRef<Span[]>([]);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const apply = useCallback((span: Span, chunk: AvailabilityChunk) => {
    inflight.current = inflight.current.filter((s) => s.fromMs !== span.fromMs || s.toMs !== span.toMs);
    if (!alive.current) return;
    setState((s) => {
      // A window that could not be read is not a window with no times.
      if (!chunk.ok || chunk.emptyReason === 'CALENDAR_UNAVAILABLE') {
        return s.slots.length === 0 ? { ...s, unavailable: true } : s;
      }
      // A configuration reason (no schedule, no hours) holds for every window.
      if (chunk.emptyReason) {
        return { ...s, emptyReason: chunk.emptyReason, known: [whole], bookingFields: s.bookingFields ?? chunk.bookingFields };
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
    inflight.current = addSpan(inflight.current, span);
    initial.then(
      (chunk) => apply(span, chunk),
      () => apply(span, { ok: false }),
    );
  }, [initial, initialFrom, initialTo, apply]);

  const source = availability?.source;
  const read = useCallback(
    (want: Span) => {
      if (!source) return;
      const have = inflight.current.reduce(addSpan, state.known);
      for (const gap of missingSpans(have, want)) {
        inflight.current = addSpan(inflight.current, gap);
        void loader(source, gap).then((chunk) => apply(gap, chunk));
      }
    },
    [source, state.known, loader, apply],
  );

  /** Read whatever of `monthKey` (in `timeZone`) the page does not have yet. */
  const ensureMonth = useCallback(
    (monthKey: string, timeZone: string) => {
      const w = monthWindow(monthKey, timeZone, nowMs, horizonMs);
      if (w) read(w);
    },
    [read, nowMs, horizonMs],
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
