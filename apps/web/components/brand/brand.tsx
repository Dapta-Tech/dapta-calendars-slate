import { IS_DAPTA_BRAND, PRODUCT_NAME } from '@/lib/product-name';
import { CalendarsMark, CalendarsWordmark } from './calendars-logo';

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
 * Call sites use `<BrandWordmark>` / `<BrandMark>` and never the raw marks, so
 * the gate cannot be forgotten on a new surface.
 */

/**
 * `dCal.` without the company name: the in-app default (the wide rail, the
 * mobile top bar), as `dForms.` is in the sibling product. Inside the app the
 * shell already says Dapta, so the wordmark only has to say which product. Size
 * it with a height class and let width follow (`h-6 w-auto`). A fork gets its
 * initial chip and the name it set, on one line.
 */
export function BrandWordmark({ className, labelled }: { className?: string; labelled?: boolean }) {
  if (IS_DAPTA_BRAND) {
    return <CalendarsWordmark className={className} title={labelled ? PRODUCT_NAME : undefined} />;
  }
  return (
    <span className="flex min-w-0 items-center gap-inline">
      <FallbackChip />
      <span className="truncate text-sm font-semibold text-foreground">{PRODUCT_NAME}</span>
    </span>
  );
}

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

/**
 * The mark inside a square tile someone else draws (an AI app's connector
 * list, the connect walkthrough): the dC mark on a Dapta build, the product's
 * initial on a fork. `size` is the tile's side in px; the ink is
 * `currentColor`, so the tile sets it.
 */
export function BrandTileMark({ size }: { size: number }) {
  if (IS_DAPTA_BRAND) return <CalendarsMark style={{ width: size * 0.74, height: 'auto' }} />;
  return (
    <span className="font-semibold leading-none" style={{ fontSize: Math.round(size * 0.55) }}>
      {PRODUCT_NAME.charAt(0)}
    </span>
  );
}

/** The pre-logo placeholder, kept as the fork fallback rather than deleted. */
function FallbackChip() {
  return (
    <span className="rounded-md bg-primary px-inline py-tight text-sm font-semibold text-primary-foreground">
      {PRODUCT_NAME.charAt(0)}
    </span>
  );
}
