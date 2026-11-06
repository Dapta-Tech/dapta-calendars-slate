'use client';

import { inputCls, type EventTypeMessages } from './shared';

/** The minimum notices a host picks from, in minutes: 1, 2, 6, 12 hours; 1 to 5 days. */
export const NOTICE_OPTIONS = [60, 120, 360, 720, 1440, 2880, 4320, 5760, 7200] as const;

/** "1 hour", "6 hours", "2 days", "30 minutes": a span in the largest whole unit. */
export function noticeLabel(minutes: number, m: EventTypeMessages['editor']['notice']): string {
  const count = (one: string, many: string, n: number) => (n === 1 ? one : many.replace('{n}', String(n)));
  if (minutes > 0 && minutes % 1440 === 0) return count(m.day, m.days, minutes / 1440);
  if (minutes > 0 && minutes % 60 === 0) return count(m.hour, m.hours, minutes / 60);
  return count(m.minute, m.minutes, minutes);
}

/**
 * Minimum notice as a choice of spans instead of a number of minutes. The value
 * is still minutes. A stored notice that is not one of the options (0, 30
 * minutes, 4 hours…) stays as an extra choice, so opening and saving an event
 * never changes it.
 */
export function NoticeField({
  id,
  value,
  onChange,
  error,
  m,
}: {
  id: string;
  value: number;
  onChange: (minutes: number) => void;
  error?: string | null;
  m: EventTypeMessages['editor']['notice'];
}) {
  const options: number[] = [...NOTICE_OPTIONS];
  if (Number.isFinite(value) && value >= 0 && !options.includes(value)) {
    options.push(value);
    options.sort((a, b) => a - b);
  }
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  return (
    <div className="flex flex-col gap-tight">
      <label htmlFor={id} className="text-sm text-muted-foreground">
        {m.label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className={inputCls}
        aria-describedby={error ? `${errorId} ${hintId}` : hintId}
        {...(error ? { 'aria-invalid': true } : {})}
      >
        {options.map((n) => (
          <option key={n} value={n}>
            {noticeLabel(n, m)}
          </option>
        ))}
      </select>
      {error ? (
        <p id={errorId} className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <p id={hintId} className="text-xs text-muted-foreground">
        {m.hint}
      </p>
    </div>
  );
}

