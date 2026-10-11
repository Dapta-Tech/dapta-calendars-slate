import { IS_DAPTA_BRAND, PRODUCT_NAME } from '@/lib/product-name';
import { CalendarsMark } from './calendars-logo';

export { IS_DAPTA_BRAND, PRODUCT_NAME };

/**
 * Brand surfaces, with the open-core gate applied once.
 *
 * The Dapta artwork may only render on a Dapta build. Dapta's pipeline injects
 * `NEXT_PUBLIC_PRODUCT_NAME` at build time (see `lib/product-name.ts`); a bare
 * fork keeps the default `Calendars` (or its own name) and gets a neutral
 * typographic brand built from whatever it called the product. Same principle
 * as `MadeWithBadge`: a fork is never forced to carry Dapta branding.
 *
 * Call sites use `<BrandMark>` and never the raw mark, so the gate cannot be
 * forgotten on a new surface.
 */

/**
 * Mark only: the collapsed rail, the top bar, the app switcher tile, narrow
 * viewports. Size it with a height class and let width follow (`h-6 w-auto`).
 */
export function BrandMark({ className, labelled }: { className?: string; labelled?: boolean }) {
  if (IS_DAPTA_BRAND) {
    return <CalendarsMark className={className} title={labelled ? PRODUCT_NAME : undefined} />;
  }
  return <FallbackChip />;
}

/** The pre-logo placeholder, kept as the fork fallback rather than deleted. */
function FallbackChip() {
  return (
    <span className="rounded-md bg-primary px-inline py-tight text-sm font-semibold text-primary-foreground">
      {PRODUCT_NAME.charAt(0)}
    </span>
  );
}
