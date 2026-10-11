import { forwardRef } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/cn';

/**
 * shadcn-style Button (copy-in registry pattern). Semantic token variants only,
 * no raw hex/px. `default` is INK, the primary of the dForms palette; `soft` is
 * a grey wash; `outline` and `ghost` are a line and nothing; `destructive` is a
 * red OUTLINE, so a delete never outshouts the primary action beside it. Radix
 * would back more complex controls; a button is a native <button> with variant
 * styling.
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-inline rounded-md text-sm font-semibold transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-[0.98] disabled:pointer-events-none disabled:border-transparent disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground',
        secondary: 'bg-secondary text-secondary-foreground',
        // The quiet one: a grey wash with ink text, for the action next to a
        // primary one ("Cancel" beside "Save"). The hover thins the wash rather
        // than naming `bg-accent`, which is the same grey as `bg-muted` on paper
        // and would give the press no visible feedback (R22).
        soft: 'bg-muted text-foreground hover:bg-muted/70',
        outline: 'border border-border bg-transparent hover:bg-accent',
        ghost: 'bg-transparent hover:bg-accent',
        destructive: 'border border-destructive text-destructive hover:bg-destructive/10',
        link: 'bg-transparent text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-10 px-control-pad py-inline',
        sm: 'h-8 px-field text-xs',
        lg: 'h-11 px-group',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, type = 'button', ...props },
  ref,
) {
  return <button ref={ref} type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
});

export { buttonVariants };
