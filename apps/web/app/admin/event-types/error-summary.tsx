'use client';

import { forwardRef } from 'react';
import type { EventTypeMessages } from './sections/shared';
import type { FieldError } from './validation';

/**
 * The errors a save found, at the top of the form. Announced when it appears
 * (`role="alert"`); each item names its tab and, clicked, opens that tab and
 * focuses the field. Server errors that name no field show as plain text.
 */
export const ErrorSummary = forwardRef<
  HTMLDivElement,
  {
    errors: readonly FieldError[];
    /** Errors from the API with no field to point at. */
    plain?: readonly string[];
    tabLabels: Record<FieldError['tab'], string>;
    onGo: (error: FieldError) => void;
    m: EventTypeMessages['editor']['errors'];
  }
>(function ErrorSummary({ errors, plain = [], tabLabels, onGo, m }, ref) {
  const count = errors.length + plain.length;
  if (count === 0) return null;
  const heading = count === 1 ? m.summaryOne : m.summaryMany.replace('{count}', String(count));
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="alert"
      data-testid="et-error-summary"
      className="flex flex-col gap-inline rounded-md border border-destructive/40 bg-destructive/5 p-card text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <p className="font-semibold text-destructive">{heading}</p>
      <ul className="flex flex-col gap-tight">
        {errors.map((e) => (
          <li key={`${e.fieldId}:${e.message}`}>
            <button
              type="button"
              onClick={() => onGo(e)}
              className="text-left text-foreground underline underline-offset-4 hover:text-primary"
            >
              <span className="font-medium">{tabLabels[e.tab]}:</span> {e.message}
            </button>
          </li>
        ))}
        {plain.map((text) => (
          <li key={text} className="text-foreground">
            {text}
          </li>
        ))}
      </ul>
    </div>
  );
});
