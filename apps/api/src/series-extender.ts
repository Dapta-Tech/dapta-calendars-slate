import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { ServerEnv } from '@slate/config/env';
import { extendHostEventSeries, listSeriesDueForExtension, loadSeriesOccurrences, type Db } from '@slate/db';
import { CalendarEffects } from './calendar-effects';
import { DB, ENV } from './tokens';

/** How often the horizon of every series is looked at. */
export const SERIES_EXTEND_EVERY_MS = 60 * 60_000;
/** First look after boot: soon, but after the outbox worker has started. */
const FIRST_RUN_MS = 60_000;

/**
 * Keeps repeating host events correct over time (ADR 0012). A series' dates
 * are written as bookings 180 days ahead; once an hour this writes the dates
 * that came within that horizon, on every replica (each date is written once,
 * under one key and the host's lock, so replicas never double up). A date that
 * meets a booking someone made beyond the old horizon is left out, and that
 * occurrence is cancelled on the calendar: a host event never displaces a
 * booking. Off in tests and when the outbox worker is off, like the worker.
 */
@Injectable()
export class SeriesExtender implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('SeriesExtender');
  private timer: ReturnType<typeof setInterval> | null = null;
  private first: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(ENV) private readonly env: ServerEnv,
    @Inject(CalendarEffects) private readonly calendar: CalendarEffects,
  ) {}

  onModuleInit(): void {
    if (!this.env.OUTBOX_WORKER_ENABLED || this.env.NODE_ENV === 'test') return;
    this.first = setTimeout(() => void this.runOnce(), FIRST_RUN_MS);
    this.first.unref?.();
    this.timer = setInterval(() => void this.runOnce(), SERIES_EXTEND_EVERY_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
    this.first = null;
    this.timer = null;
  }

  /** Extend every series that is due, a batch at a time. Never throws. Answers how many dates were written. */
  async runOnce(now: number = Date.now()): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    let added = 0;
    try {
      for (let round = 0; round < 20; round++) {
        const due = await listSeriesDueForExtension(this.db, now);
        if (due.length === 0) break;
        let progressed = false;
        for (const id of due) {
          try {
            const out = await extendHostEventSeries(this.db, id, now);
            if (!out) continue;
            progressed = true;
            added += out.added;
            if (out.skipped.length > 0) {
              const anchor = (await loadSeriesOccurrences(this.db, id))[0]?.uid;
              if (anchor) this.calendar.onSeriesDatesCancelled(id, anchor, out.skipped.map((d) => d.startMs));
              this.log.warn(`series ${id}: ${out.skipped.length} date(s) left out, a booking was already there`);
            }
          } catch (err) {
            this.log.error(`series ${id} could not be extended: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        if (!progressed) break;
      }
    } finally {
      this.running = false;
    }
    return added;
  }
}
