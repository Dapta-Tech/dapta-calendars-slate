import { cn } from '@/lib/cn';

/** The three states a booking shows a person. `rejected` reads as cancelled. */
export type BookingChipStatus = 'confirmed' | 'pending' | 'cancelled';

/**
 * A booking's state as a pill with a dot: green once it is confirmed, amber while
 * it waits on the host, grey once it is off. The bookings list, a booking's own
 * page and the dashboard say it, so they say it the same way.
 *
 * The colour is never the only signal: the label always renders, and the dot is
 * decoration (`aria-hidden`). The washes are measured in `tokens.spec.ts` ("a
 * status chip wash carries ink at AA").
 */
export function StatusChip({
  status,
  label,
  title,
  testId,
}: {
  status: BookingChipStatus;
  /** The visible word, already localised. */
  label: string;
  /** Optional longer explanation, shown on hover. */
  title?: string;
  testId?: string;
}) {
  return (
    <span
      data-testid={testId}
      data-status={status}
      title={title}
      className={cn(
        'inline-flex max-w-full items-center gap-tight rounded-full px-inline py-tight text-xs font-medium text-foreground',
        status === 'confirmed' && 'bg-signal/20',
        status === 'pending' && 'bg-warning/20',
        status === 'cancelled' && 'bg-muted text-muted-foreground',
      )}
    >
      <span
        aria-hidden
        className={cn(
          'h-1.5 w-1.5 shrink-0 rounded-full',
          status === 'confirmed' && 'bg-signal-edge',
          status === 'pending' && 'bg-warning',
          status === 'cancelled' && 'bg-faint',
        )}
      />
      <span className="truncate">{label}</span>
    </span>
  );
}
