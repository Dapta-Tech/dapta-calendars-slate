import type { CSSProperties, ReactNode } from 'react';
import { accentVars, widgetStyleVars, clampAccent, onAccent, DEFAULT_ACCENT } from '@slate/shared';

/**
 * Wraps a public surface with the host's branding — the SAME engine output the
 * studio preview uses (preview == prod). Applies the accent (AA-clamped) as the
 * page's `--primary` so all existing `bg-primary`/`text-primary-foreground`
 * components pick up the brand color, plus the widget vars (radii/spacing/font).
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
    fontFamily: 'var(--bp-font-body)',
  } as CSSProperties;

  return <div style={vars}>{children}</div>;
}
