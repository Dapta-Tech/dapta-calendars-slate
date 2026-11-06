'use client';

import { type BookingMessages } from '@slate/shared';

export type EventTypeMessages = BookingMessages['admin']['eventTypes'];

export const FIELD_TYPES = ['text', 'textarea', 'email', 'phone', 'number', 'select', 'checkbox', 'guests'];

export const SCHEDULING_METHODS = ['round_robin', 'collective', 'fixed_round_robin'] as const;

export type SchedulingMethod = (typeof SCHEDULING_METHODS)[number];

export interface IntakeField {
  name: string;
  label: string;
  type: string;
  required: boolean;
  /** Phone questions: country the selector starts on (QA4 fix 1b). */
  defaultCountry?: string;
  /**
   * select/checkbox choices. The editor has no control for these yet — they
   * arrive through the API — but they are carried through so the CRM mapping
   * section can reconcile them against an enumeration property's options, and
   * so a save cannot silently drop the options an event already had.
   */
  options?: string[];
}

export interface HostRow {
  memberId: string;
  priority: number | null;
  weight: number | null;
  isFixed: boolean;
}

export interface TeamMemberOption {
  memberId: string;
  displayName: string | null;
  /** The name of last resort, after `displayName`. */
  email?: string | null;
  /** Undefined when the API predates the field: unknown, never "missing". */
  hasDestinationCalendar?: boolean;
  /** Any connected calendar (busy times are checked against it). Undefined = unknown. */
  hasCalendar?: boolean;
  /** Working hours on their default schedule. Undefined = unknown. */
  hasHours?: boolean;
}

export const inputCls =
  'w-full rounded-md border border-input bg-background px-field py-inline text-sm transition-colors placeholder:text-muted-foreground hover:border-muted-foreground focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/**
 * One host control in a team event's Hosts block. From `sm` up it steps aside
 * (`contents`) and the control sits under its column header; below `sm` the
 * header is hidden, so the control shows its column's name beside it. The
 * name is for the eye only: each control already has its own accessible label.
 */
export function HostCell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-field sm:contents">
      <span aria-hidden className="text-xs text-muted-foreground sm:hidden">
        {label}
      </span>
      {children}
    </div>
  );
}

/**
 * A labelled control. `required` adds the `*` mark (hidden from assistive
 * technology, which hears `requiredLabel` instead); `error` renders under the
 * control with `errorId`, which the control should name in `aria-describedby`
 * (see `errorAria`).
 */
export function Field({
  label,
  children,
  required,
  requiredLabel,
  error,
  errorId,
}: {
  label: string;
  children: React.ReactNode;
  required?: boolean;
  requiredLabel?: string;
  error?: string | null;
  errorId?: string;
}) {
  return (
    <div className="flex flex-col gap-tight">
      <label className="flex flex-col gap-tight text-sm">
        <span className="text-muted-foreground">
          {label}
          {required ? (
            <>
              <span aria-hidden className="text-destructive">
                {' '}
                *
              </span>
              {requiredLabel ? <span className="sr-only"> ({requiredLabel})</span> : null}
            </>
          ) : null}
        </span>
        {children}
      </label>
      {error ? (
        <p id={errorId} className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** The attributes a control needs to point at its shown error (or none). */
export function errorAria(error: string | null | undefined, errorId: string) {
  return error ? { 'aria-invalid': true as const, 'aria-describedby': errorId } : {};
}

/** Same inline chevron style as the DateTimePicker's month arrows. */
export function ChevronIcon({ direction }: { direction: 'up' | 'down' }) {
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
      {direction === 'up' ? <path d="M18 15l-6-6-6 6" /> : <path d="M6 9l6 6 6-6" />}
    </svg>
  );
}
