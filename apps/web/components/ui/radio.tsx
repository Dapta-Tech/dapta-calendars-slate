import { forwardRef } from 'react';
import { cn } from '@/lib/cn';

/**
 * shadcn-style Radio — same token-driven pattern as `Checkbox` (lime fill +
 * near-black dot when on, on-surface border when off; no raw hex, both
 * themes). Used by the per-event "Add events here" destination picker.
 */
export const Radio = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Radio({ className, ...props }, ref) {
    return (
      <span className="relative inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center">
        <input
          ref={ref}
          type="radio"
          className={cn(
            'peer h-[18px] w-[18px] shrink-0 cursor-pointer appearance-none rounded-full border border-input bg-background transition-colors',
            'hover:border-muted-foreground checked:border-primary',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            className,
          )}
          {...props}
        />
        <span className="pointer-events-none absolute h-2 w-2 scale-0 rounded-full bg-primary opacity-0 transition-all peer-checked:scale-100 peer-checked:opacity-100" />
      </span>
    );
  },
);
