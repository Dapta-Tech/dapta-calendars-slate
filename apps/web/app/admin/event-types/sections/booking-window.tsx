'use client';

import { useId } from 'react';
import { t } from '@slate/shared';
import { MAX_BOOKING_WINDOW_DAYS } from '@slate/types';
import { EventTypeMessages, Field, inputCls } from './shared';

/**
 * The booking window: one number on the grid of the timing fields above it
 * (same column width, so it lines up under Length and Buffer before), with its
 * hint below the row. The hint always shows, because it says how the days are
 * counted; the error joins it.
 */
export function BookingWindowField({
  inputRef,
  value,
  onChange,
  onBlur,
  invalid,
  m,
}: {
  inputRef: React.Ref<HTMLInputElement>;
  value: number | '';
  onChange: (v: number | '') => void;
  onBlur: () => void;
  invalid: boolean;
  m: EventTypeMessages['bookingWindow'];
}) {
  const hintId = useId();
  const errorId = useId();
  return (
    <div className="flex flex-col gap-tight">
      <div className="grid grid-cols-3 gap-field">
        <Field label={m.label}>
          {/* No `min`/`max`/`step`: this form has no `noValidate`, so the
              browser's own bubble would fire before the error below. */}
          <input
            id="et-booking-window"
            ref={inputRef}
            type="number"
            inputMode="numeric"
            placeholder={m.placeholder}
            value={value}
            onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
            onBlur={onBlur}
            aria-invalid={invalid ? true : undefined}
            aria-describedby={invalid ? `${errorId} ${hintId}` : hintId}
            className={inputCls}
          />
        </Field>
      </div>
      {invalid ? (
        <p id={errorId} className="text-xs text-destructive" role="alert">
          {t(m.invalid, { max: MAX_BOOKING_WINDOW_DAYS })}
        </p>
      ) : null}
      <p id={hintId} className="text-xs text-muted-foreground">
        {m.hint}
      </p>
    </div>
  );
}
