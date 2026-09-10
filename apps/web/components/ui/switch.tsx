'use client';

import { cn } from '@/lib/cn';

/**
 * shadcn-style Switch — a token-driven on/off toggle (lime track when on,
 * muted when off; no raw hex, both themes — Design Quality Bar §11). Renders a
 * real `role="switch"` button so screen readers announce the state.
 *
 * A2 (#112): the TRACK is 22px, which is what a switch should look like, and
 * was also the whole touch target — half the 44px bar. The `after:` overlay
 * extends the clickable box to 44px tall without touching the painted control,
 * so the switch looks identical and a thumb can actually hit it. It is only as
 * wide as the track, so it never swallows a click meant for the label beside it.
 */
export function Switch({
  checked,
  onCheckedChange,
  disabled,
  'aria-label': ariaLabel,
  className,
}: {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  disabled?: boolean;
  'aria-label'?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        'relative inline-flex h-[22px] w-[38px] shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors',
        "after:absolute after:-inset-y-[11px] after:inset-x-0 after:content-['']",
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        checked ? 'bg-primary' : 'bg-muted-foreground/30',
        disabled && 'cursor-not-allowed opacity-50',
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          'pointer-events-none block h-[18px] w-[18px] rounded-full bg-background shadow-sm transition-transform',
          checked ? 'translate-x-[17px]' : 'translate-x-[2px]',
        )}
      />
    </button>
  );
}
