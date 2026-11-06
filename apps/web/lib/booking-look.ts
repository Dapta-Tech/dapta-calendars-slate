import { DEFAULT_ACCENT, defaultBranding, type PublicBranding } from '@slate/shared';
import { bookingCanvasOf } from '@/lib/booking-canvas';

/** The style axes a booking page renders with. */
export type BookingAxes = Pick<
  PublicBranding,
  'template' | 'cardStyle' | 'corners' | 'buttons' | 'density' | 'font' | 'slotLayout' | 'dayGroup' | 'slotSelect' | 'theme'
>;

/**
 * The look a host's booking page wears, from their stored style: the accent and
 * every axis, each absent one resolved the way the public page resolves it.
 * One function for the booking-page studio and the event editor's preview, so
 * the two previews and the live page cannot disagree about an old config.
 */
export function bookingLookOf(
  style: Record<string, unknown>,
  brandColor: string | null | undefined,
  displayName: string,
): { accent: string; axes: BookingAxes } {
  const def = defaultBranding(displayName);
  return {
    accent: brandColor ?? DEFAULT_ACCENT,
    axes: {
      template: (style.template as never) ?? def.template,
      cardStyle: (style.cardStyle as never) ?? def.cardStyle,
      corners: (style.corners as never) ?? def.corners,
      buttons: (style.buttons as never) ?? def.buttons,
      density: (style.density as never) ?? def.density,
      font: (style.font as never) ?? def.font,
      slotLayout: (style.slotLayout as never) ?? def.slotLayout,
      dayGroup: (style.dayGroup as never) ?? def.dayGroup,
      slotSelect: (style.slotSelect as never) ?? def.slotSelect,
      // Through the resolver, never a literal: an absent axis resolves in
      // exactly one place (ADR 0004's amendment moved the literal once already).
      theme: bookingCanvasOf(style),
    },
  };
}
