'use client';

import { useId } from 'react';
import { LIMIT_KEYS, type LimitKey, type LimitsDraft } from '../draft';
import { FIELD_IDS } from '../validation';
import { errorAria, EventTypeMessages, Field, inputCls } from './shared';

const LABELS: Record<LimitKey, 'bookingsPerDay' | 'bookingsPerWeek' | 'minutesPerDay' | 'minutesPerWeek'> = {
  maxBookingsPerDay: 'bookingsPerDay',
  maxBookingsPerWeek: 'bookingsPerWeek',
  maxMinutesPerDay: 'minutesPerDay',
  maxMinutesPerWeek: 'minutesPerWeek',
};

/**
 * Booking limits: four numbers, per day in the left column and per week in the
 * right, bookings above and total minutes below, each empty for no limit. The
 * hint always shows, because it says how a day and a week are counted; each
 * field's error (from `validateDraft`) sits under it.
 */
export function BookingLimitsFields({
  value,
  onChange,
  onBlur,
  errorFor,
  m,
}: {
  value: LimitsDraft;
  onChange: (key: LimitKey, v: number | '') => void;
  onBlur: (fieldId: string) => void;
  errorFor: (fieldId: string) => string | null;
  m: EventTypeMessages['bookingLimits'];
}) {
  const titleId = useId();
  const hintId = useId();
  return (
    <div role="group" aria-labelledby={titleId} aria-describedby={hintId} className="flex flex-col gap-tight">
      <span id={titleId} className="text-sm font-semibold text-foreground">
        {m.title}
      </span>
      <div className="grid grid-cols-1 gap-field sm:grid-cols-2">
        {LIMIT_KEYS.map((key) => {
          const id = FIELD_IDS.limit(key);
          const error = errorFor(id);
          return (
            <Field key={key} label={m[LABELS[key]]} error={error} errorId={`${id}-error`}>
              <input
                id={id}
                type="number"
                inputMode="numeric"
                placeholder={m.placeholder}
                value={value[key]}
                onChange={(e) => onChange(key, e.target.value === '' ? '' : Number(e.target.value))}
                onBlur={() => onBlur(id)}
                className={inputCls}
                {...errorAria(error, `${id}-error`)}
              />
            </Field>
          );
        })}
      </div>
      <p id={hintId} className="text-xs text-muted-foreground">
        {m.hint}
      </p>
    </div>
  );
}
