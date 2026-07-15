'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Locale } from '@slate/shared';
import { cn } from '@/lib/cn';

/**
 * DateTimePicker — a token-driven replacement for <input type="datetime-local">.
 * The native control renders an un-themeable browser popup (white surface,
 * browser-blue selection) that fails the Design Quality Bar on the dark theme
 * — same rationale as TimeField. This is a month calendar grid + a time list
 * (stepMinutes granularity — the event type's slot interval, QA2 fix 2), both
 * styled like the slot-grid buttons in host-booking-form.
 *
 * Value in/out is the same wall-clock 'YYYY-MM-DDTHH:mm' string the native
 * input produced (no timezone attached), so callers keep owning the timezone
 * interpretation (e.g. wallClockToUtc in host-booking-form) untouched.
 *
 * Dependency-free on purpose: plain Date math, weeks start Monday, and all
 * month/weekday names come from Intl with the active locale — no i18n keys
 * needed for calendar vocabulary.
 */

function buildTimeOptions(stepMin: number): string[] {
  // Guard nonsense steps (0, negative, >1 day) back to the 30-min default.
  const step = Number.isFinite(stepMin) && stepMin >= 1 && stepMin <= 720 ? Math.round(stepMin) : 30;
  const out: string[] = [];
  for (let t = 0; t < 24 * 60; t += step) {
    out.push(`${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`);
  }
  return out;
}

const pad = (n: number) => String(n).padStart(2, '0');
const dateKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

function parseValue(value: string): { date: string; time: string } | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(value);
  return m ? { date: m[1]!, time: m[2]! } : null;
}

function ChevronIcon({ direction }: { direction: 'left' | 'right' }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
    >
      {direction === 'left' ? <path d="M15 18l-6-6 6-6" /> : <path d="M9 6l6 6-6 6" />}
    </svg>
  );
}

export function DateTimePicker({
  value,
  onChange,
  minDate,
  maxDate,
  locale = 'en',
  timeLabel,
  stepMinutes = 30,
  dateStatusLabel,
  timeStatusLabel,
  missingLabel,
}: {
  /** Wall-clock 'YYYY-MM-DDTHH:mm' string, or '' when nothing is picked yet. */
  value: string;
  onChange: (next: string) => void;
  /** Selectable range: defaults to today → +2 years, mirroring the server-side
   *  rule (past dates and >2y future are rejected with 400). */
  minDate?: Date;
  maxDate?: Date;
  locale?: Locale;
  /** Accessible label for the time list (pass an i18n string). */
  timeLabel?: string;
  /** Time-list granularity — pass the event type's slot interval (QA2 fix 2). */
  stepMinutes?: number;
  /** Status-bar labels (i18n): "Date" / "Time" / "not picked yet". When
   *  provided, a summary bar shows both halves and flags the missing one, so
   *  "Pick a time" errors stop reading as a contradiction (QA2 fix 8a). */
  dateStatusLabel?: string;
  timeStatusLabel?: string;
  missingLabel?: string;
}) {
  const parsed = parseValue(value);
  // Date and time are picked independently; onChange only fires once both
  // halves exist so the parent never sees a half-formed value.
  const [date, setDate] = useState<string>(parsed?.date ?? '');
  const [time, setTime] = useState<string>(parsed?.time ?? '');

  // Keep internal halves in sync if the parent resets/overwrites the value
  // (e.g. clearing the form). Partial local picks emit no value change, so
  // this never clobbers an in-progress selection.
  useEffect(() => {
    const p = parseValue(value);
    if (p) {
      setDate(p.date);
      setTime(p.time);
    } else if (value === '') {
      setDate('');
      setTime('');
    }
  }, [value]);

  const today = startOfDay(new Date());
  const min = startOfDay(minDate ?? today);
  const max = startOfDay(
    maxDate ?? new Date(today.getFullYear() + 2, today.getMonth(), today.getDate()),
  );

  const [viewMonth, setViewMonth] = useState<Date>(() => {
    const p = parseValue(value);
    return p
      ? new Date(Number(p.date.slice(0, 4)), Number(p.date.slice(5, 7)) - 1, 1)
      : new Date(today.getFullYear(), today.getMonth(), 1);
  });

  const y = viewMonth.getFullYear();
  const mo = viewMonth.getMonth();
  // Monday-start grid: JS getDay() is Sunday-based, shift by 6.
  const leadingBlanks = (new Date(y, mo, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(y, mo + 1, 0).getDate();

  const timeOptions = useMemo(() => buildTimeOptions(stepMinutes), [stepMinutes]);

  const monthFmt = useMemo(
    () => new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }),
    [locale],
  );
  const pickedDateFmt = useMemo(
    () => new Intl.DateTimeFormat(locale, { weekday: 'short', month: 'short', day: 'numeric' }),
    [locale],
  );
  const weekdays = useMemo(() => {
    const fmt = new Intl.DateTimeFormat(locale, { weekday: 'short' });
    // 2024-01-01 is a Monday — format seven consecutive days from it.
    return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2024, 0, 1 + i)));
  }, [locale]);

  // Nav is allowed while the adjacent month still contains selectable days.
  const canPrev = new Date(y, mo, 0) >= min;
  const canNext = new Date(y, mo + 1, 1) <= max;

  const pickDate = (d: string) => {
    setDate(d);
    if (time) onChange(`${d}T${time}`);
  };
  const pickTime = (t: string) => {
    setTime(t);
    if (date) onChange(`${date}T${t}`);
  };

  // Selection summary: both halves at a glance, the missing one flagged —
  // date and time are picked independently, so without this the "Pick a time"
  // error contradicts what the user sees selected (QA2 fix 8a).
  const statusBar =
    dateStatusLabel && timeStatusLabel ? (
      <div className="flex flex-wrap gap-2 border-b border-border pb-2 text-xs" aria-live="polite">
        <span
          className={cn(
            'rounded-sm px-2 py-1',
            date ? 'bg-primary/10 font-medium text-primary' : 'bg-muted text-muted-foreground',
          )}
        >
          {dateStatusLabel}:{' '}
          {date
            ? pickedDateFmt.format(new Date(`${date}T00:00`))
            : `— ${missingLabel ?? ''}`.trim()}
        </span>
        <span
          className={cn(
            'rounded-sm px-2 py-1',
            time ? 'bg-primary/10 font-medium text-primary' : 'bg-muted text-muted-foreground',
          )}
        >
          {timeStatusLabel}: {time || `— ${missingLabel ?? ''}`.trim()}
        </span>
      </div>
    ) : null;

  return (
    <div className="flex flex-col gap-3 rounded-md border border-border bg-background p-3">
      {statusBar}
      <div className="flex flex-col gap-3 sm:flex-row">
      {/* Month calendar */}
      <div className="flex-1">
        <div className="mb-2 flex items-center justify-between">
          <button
            type="button"
            disabled={!canPrev}
            onClick={() => setViewMonth(new Date(y, mo - 1, 1))}
            // Intl-formatted target month doubles as the locale-aware label —
            // no i18n key needed for "previous month".
            aria-label={monthFmt.format(new Date(y, mo - 1, 1))}
            className="rounded-md border border-border bg-background p-1.5 transition-colors hover:border-primary disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border"
          >
            <ChevronIcon direction="left" />
          </button>
          {/* capitalize: es-ES month names are lowercase ("julio de 2026") */}
          <span className="text-sm font-medium capitalize">{monthFmt.format(viewMonth)}</span>
          <button
            type="button"
            disabled={!canNext}
            onClick={() => setViewMonth(new Date(y, mo + 1, 1))}
            aria-label={monthFmt.format(new Date(y, mo + 1, 1))}
            className="rounded-md border border-border bg-background p-1.5 transition-colors hover:border-primary disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-border"
          >
            <ChevronIcon direction="right" />
          </button>
        </div>
        <div className="grid grid-cols-7 gap-1 text-center">
          {weekdays.map((w) => (
            <span key={w} className="py-1 text-[11px] uppercase text-muted-foreground">
              {w}
            </span>
          ))}
          {Array.from({ length: leadingBlanks }, (_, i) => (
            <span key={`blank-${i}`} aria-hidden />
          ))}
          {Array.from({ length: daysInMonth }, (_, i) => {
            const day = i + 1;
            const key = `${y}-${pad(mo + 1)}-${pad(day)}`;
            const dayDate = new Date(y, mo, day);
            const disabled = dayDate < min || dayDate > max;
            const selected = key === date;
            const isToday = key === dateKey(today);
            return (
              <button
                key={key}
                type="button"
                disabled={disabled}
                onClick={() => pickDate(key)}
                aria-pressed={selected}
                className={cn(
                  'rounded-md border py-1.5 text-xs tabular-nums transition-colors',
                  selected
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-background hover:border-primary',
                  // Today gets a dot UNDER the number, never a primary border —
                  // a bordered today reads as a second selection (QA2 fix 8b).
                  isToday &&
                    !selected &&
                    "relative font-semibold after:absolute after:bottom-0.5 after:left-1/2 after:h-1 after:w-1 after:-translate-x-1/2 after:rounded-full after:bg-primary after:content-['']",
                  disabled && 'cursor-not-allowed opacity-40 hover:border-border',
                )}
              >
                {day}
              </button>
            );
          })}
        </div>
      </div>

      {/* Time of day — stepMinutes granularity, scrolls like the slot grid */}
      <div
        role="group"
        aria-label={timeLabel}
        className="grid max-h-64 grid-cols-4 content-start gap-1 overflow-y-auto sm:w-44 sm:grid-cols-2"
      >
        {timeOptions.map((t) => {
          const selected = t === time;
          return (
            <button
              key={t}
              type="button"
              onClick={() => pickTime(t)}
              aria-pressed={selected}
              className={cn(
                'rounded-md border px-2 py-1.5 text-xs tabular-nums transition-colors',
                selected
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-background hover:border-primary',
              )}
            >
              {t}
            </button>
          );
        })}
      </div>
      </div>
    </div>
  );
}
