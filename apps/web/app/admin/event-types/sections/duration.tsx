'use client';

import { useState } from 'react';
import { cn } from '@/lib/cn';
import { errorAria, inputCls, type EventTypeMessages } from './shared';

/** The lengths most meetings take: one click instead of typing a number. */
export const DURATION_PRESETS = [15, 30, 45, 60] as const;

/**
 * Duration as chips (15 / 30 / 45 / 60 min) plus Custom, which opens a minutes
 * field. A stored length that is not a preset (25, 90) opens on Custom with
 * its number, so editing never changes it.
 */
export function DurationField({
  value,
  onChange,
  onBlur,
  error,
  m,
}: {
  value: number;
  onChange: (minutes: number) => void;
  onBlur?: () => void;
  error?: string | null;
  m: EventTypeMessages['editor'];
}) {
  const isPreset = (DURATION_PRESETS as readonly number[]).includes(value);
  const [custom, setCustom] = useState(!isPreset);
  const errorId = 'et-duration-error';
  const chip = (selected: boolean) =>
    cn(
      'min-h-control rounded-md border px-field text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      selected
        ? 'border-signal-edge bg-signal/10 text-foreground'
        : 'border-border bg-card text-muted-foreground hover:border-foreground/20 hover:text-foreground',
    );

  return (
    <fieldset className="flex flex-col gap-tight">
      <legend className="mb-tight text-sm text-muted-foreground">
        {m.duration.label}
        <span aria-hidden className="text-destructive">
          {' '}
          *
        </span>
        <span className="sr-only"> ({m.required})</span>
      </legend>
      <div className="flex flex-wrap items-center gap-inline">
        {DURATION_PRESETS.map((n) => {
          const selected = !custom && value === n;
          return (
            <button
              key={n}
              type="button"
              aria-pressed={selected}
              onClick={() => {
                setCustom(false);
                onChange(n);
              }}
              className={chip(selected)}
            >
              {n} {m.duration.minutes}
            </button>
          );
        })}
        <button
          type="button"
          aria-pressed={custom}
          onClick={() => setCustom(true)}
          className={chip(custom)}
        >
          {m.duration.custom}
        </button>
        {custom ? (
          <label className="flex items-center gap-inline text-sm text-muted-foreground">
            <span className="sr-only">{m.duration.customLabel}</span>
            <input
              id="et-duration"
              type="number"
              min={1}
              max={1440}
              value={Number.isFinite(value) ? value : ''}
              onChange={(e) => onChange(e.target.value === '' ? Number.NaN : Number(e.target.value))}
              onBlur={onBlur}
              className={cn(inputCls, 'w-24')}
              {...errorAria(error, errorId)}
            />
            {m.duration.minutes}
          </label>
        ) : (
          // The error target when no custom field is open: the chips' group.
          <span id="et-duration" tabIndex={-1} className="sr-only">
            {m.duration.label}
          </span>
        )}
      </div>
      {error ? (
        <p id={errorId} className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
