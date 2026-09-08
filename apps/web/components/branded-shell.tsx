import type { CSSProperties, ReactNode } from 'react';
import { brandVars, widgetStyleVars, brandingClassOf, DEFAULT_ACCENT } from '@slate/shared';
import { BOOKING_CANVAS } from '@/lib/booking-canvas';

/**
 * Wraps a public surface with the host's branding — the SAME engine output the
 * studio preview uses (preview == prod). Applies the accent (clamped for the
 * page's canvas) as the page's `--primary`, derives the accent's other two jobs
 * (`--primary-ink` as letters, `--primary-edge` as rim and focus outline) from
 * that same accent, and emits the widget vars (radii/spacing/font) plus
 * brandingClassOf() so the class-driven axes render via the .branded-surface
 * CSS. All 9 axes reach the DOM through this single wrapper.
 *
 * The ink/edge pair is not decoration: globals.css re-points `text-primary` at
 * `--primary-ink` and rims every accent fill with `--primary-edge`, both of
 * which resolve from the PRODUCT palette unless a branded surface sets them.
 * Without them the host's links and rims come out in our lime (ADR 0004).
 */
export function BrandedShell({
  brandColor,
  style,
  children,
}: {
  brandColor: string | null;
  style: Record<string, unknown> | null;
  children: ReactNode;
}) {
  const axes = (style ?? {}) as Record<string, string>;
  const vars = {
    ...brandVars(brandColor ?? DEFAULT_ACCENT, BOOKING_CANVAS),
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

  return (
    <div className={cls} style={vars}>
      {children}
    </div>
  );
}
