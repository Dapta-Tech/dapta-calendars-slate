import type { CSSProperties, ReactNode } from 'react';
import { brandVars, widgetStyleVars, brandingClassOf, DEFAULT_ACCENT } from '@slate/shared';
import { bookingCanvasOf } from '@/lib/booking-canvas';
import { CanvasStamp } from '@/components/canvas-stamp';

/**
 * Wraps a public surface with the host's branding — the SAME engine output the
 * studio preview uses (preview == prod). Applies the host's accent, unaltered,
 * as the page's `--primary`, and emits the accent's other two jobs
 * (`--primary-ink` as letters, `--primary-edge` as rim and focus outline) from
 * that same accent so neither falls through to the PRODUCT's lime — which is
 * why they are emitted even though all three are now one colour (ADR 0004's
 * amendment). Also emits the widget vars (radii/spacing/font) plus
 * brandingClassOf() so the class-driven axes render via the .branded-surface
 * CSS. All 10 axes reach the DOM through this single wrapper.
 *
 * The ink/edge pair is not decoration: globals.css re-points `text-primary` at
 * `--primary-ink` and rims every accent fill with `--primary-edge`, both of
 * which resolve from the PRODUCT palette unless a branded surface sets them.
 * Without them the host's links and rims come out in our lime (ADR 0004).
 *
 * B2 adds the tenth axis, and it is the one that is not a custom property: the
 * shell STAMPS `data-theme` on itself and paints `--background`/`--foreground`,
 * so the whole subtree resolves the surface ladder — page, card, popover,
 * border, muted — from the canvas the HOST chose rather than from whatever the
 * document happens to be. That is what lets the studio render the invitee's
 * light page inside the admin's dark one, and it is why `--accent-wash`
 * (`color-mix(… , var(--background))`) composites against the right ground on
 * both surfaces instead of only agreeing about the accent itself.
 */
export function BrandedShell({
  brandColor,
  style,
  className,
  children,
}: {
  brandColor: string | null;
  style: Record<string, unknown> | null;
  /**
   * Appended to the branding classes. The embed (E) hangs `dc-embed` here so
   * its CSS can out-specify a `.branded-surface` rule without `!important`:
   * both classes land on the same element, so `.branded-surface.dc-embed …`
   * beats `.branded-surface …` on its own.
   */
  className?: string;
  children: ReactNode;
}) {
  const axes = (style ?? {}) as Record<string, string>;
  // The canvas the accent's tokens are derived against and the canvas the page
  // paints on are ONE fact, read once from the same style object the class axes
  // come from.
  const canvas = bookingCanvasOf(style);
  const vars = {
    ...brandVars(brandColor ?? DEFAULT_ACCENT, canvas),
    ...widgetStyleVars({
      corners: axes.corners as never,
      density: axes.density as never,
      font: axes.font as never,
      buttons: axes.buttons as never,
    }),
  } as CSSProperties;

  const cls = brandingClassOf({
    template: axes.template as never,
    cardStyle: axes.cardStyle as never,
    slotLayout: axes.slotLayout as never,
    dayGroup: axes.dayGroup as never,
    slotSelect: axes.slotSelect as never,
  });

  // `bg-background text-foreground` on the shell itself, not only on `<body>`:
  // the shell may be stamping a canvas the document is not on (a dark booking
  // page under the light document default, or the studio preview inside the
  // admin), and a subtree that re-establishes a theme has to repaint its own
  // ground or it reads as text of one theme sitting on the ground of the other.
  return (
    <div
      data-theme={canvas}
      className={`${cls} bg-background text-foreground${className ? ` ${className}` : ''}`}
      style={vars}
    >
      {/* Carries this canvas up to `<html>` on a soft navigation. Inert on a
          hard load, where the server already stamped it. */}
      <CanvasStamp canvas={canvas} />
      {children}
    </div>
  );
}
