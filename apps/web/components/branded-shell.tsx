import type { CSSProperties, ReactNode } from 'react';
import {
  accentVars,
  widgetStyleVars,
  brandingClassOf,
  clampAccent,
  onAccent,
  DEFAULT_ACCENT,
} from '@slate/shared';

/**
 * Wraps a public surface with the host's branding — the SAME engine output the
 * studio preview uses (preview == prod). Applies the accent (AA-clamped) as the
 * page's `--primary` and the widget vars (radii/spacing/font), AND emits
 * brandingClassOf() so the class-driven axes (cardStyle/slotLayout/dayGroup/
 * slotSelect/template) render via the .branded-surface CSS. All 9 axes reach the
 * DOM through this single wrapper.
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
  const accent = clampAccent(brandColor ?? DEFAULT_ACCENT);
  const axes = (style ?? {}) as Record<string, string>;
  const vars = {
    ...accentVars(accent),
    ...widgetStyleVars({
      corners: axes.corners as never,
      density: axes.density as never,
      font: axes.font as never,
      buttons: axes.buttons as never,
    }),
    '--primary': accent,
    '--primary-foreground': onAccent(accent),
    '--ring': accent,
    /* The accent's other two jobs, emitted so the product's lime cannot leak onto
       a host's page. globals.css re-points the `text-primary` utility at
       `--primary-ink` and rims every `bg-primary` with `--primary-edge`; both are
       product tokens, so without these two lines a branded surface would render
       the growth link in OUR lime and put a lime rim on the host's own button.
       Set to the clamped accent, which reproduces today's behaviour exactly: one
       clamp, one direction, dark ground assumed. This is the temporary shape for
       the window before the theme-aware derivation lands — ADR 0004 owns the real
       one, along with the bidirectional `clampAccent(color, canvas)`. */
    '--primary-ink': accent,
    '--primary-edge': accent,
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
