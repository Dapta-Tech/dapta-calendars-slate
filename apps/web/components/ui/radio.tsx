import { forwardRef } from 'react';
import { cn } from '@/lib/cn';

/**
 * shadcn-style Radio — same token-driven pattern as `Checkbox` (lime fill +
 * near-black dot when on, on-surface border when off; no raw hex, both
 * themes). Used by the per-event "Add events here" destination picker.
 *
 * Both accent marks here are `--primary-edge`: the checked dot because F (#80)
 * moved sub-10px fills off `--primary` (a 1px rim on a 6px dot reads as a
 * donut), and the checked border for the same reason `Checkbox`'s does — the
 * `.bg-primary` rim in `globals.css` cannot reach a `checked:`-prefixed class,
 * so a raw-accent edge sat at 1.27:1 on paper.
 *
 * `checked:hover:border-primary-edge` is not redundant. `hover:border-*` and
 * `checked:border-*` are both one-variant rules at equal specificity, and the
 * hover rule compiles LATER, so without the two-variant form a checked control
 * loses its accent edge the moment the cursor is over it. `Checkbox` carries the
 * same pair.
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
            'hover:border-muted-foreground checked:border-primary-edge checked:hover:border-primary-edge',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            className,
          )}
          {...props}
        />
        <span className="pointer-events-none absolute h-2 w-2 scale-0 rounded-full bg-primary-edge opacity-0 transition-all peer-checked:scale-100 peer-checked:opacity-100" />
      </span>
    );
  },
);
