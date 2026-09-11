import { DEFAULT_BOOKING_THEME, type BrandCanvas } from '@slate/shared';

/**
 * The ground a booking page paints on — ADR 0004's tenth style axis, resolved.
 *
 * `theme: 'light' | 'dark'` is stored on the page's style object, set by the
 * host in the studio, overridable per-embed by URL parameter, and NEVER
 * influenced by the host's own admin theme cookie. There is no `auto`.
 *
 * Everything lives in one module because the studio renders a live preview and
 * that preview IS production. The public shell, the preview and the document
 * stamp reading the same function is what makes them unable to disagree — a
 * second copy of `style.theme ?? 'light'` at a call site is the whole class of
 * bug this file exists to prevent.
 */

/**
 * What an ABSENT axis means, and it means paper.
 *
 * `brandingSchema.style` is `bookingPageStyleSchema.partial()`, so every config
 * saved before B2 carries no `theme` key at all. Those pages therefore move
 * from dark to light the day this ships. Per ADR 0004 that is the intended
 * outcome rather than a regression — but it is a visible change to live pages,
 * so it ships as one change and is announced rather than discovered.
 */
export const DEFAULT_BOOKING_CANVAS: BrandCanvas = DEFAULT_BOOKING_THEME;

/**
 * The canvas a stored style object asks for.
 *
 * Deliberately tolerant of `unknown`: the style column is `jsonb`, the web app
 * reads it as an opaque record off the public API, and an unrecognised value
 * has to resolve to the default rather than throw on the invitee's page. The
 * enum itself is validated at the two write boundaries that matter — the API's
 * `brandingSchema.parse` on save, and `parseEmbedParams` on a URL override.
 */
export function bookingCanvasOf(style: Record<string, unknown> | null | undefined): BrandCanvas {
  const theme = (style ?? {}).theme;
  return theme === 'dark' || theme === 'light' ? theme : DEFAULT_BOOKING_CANVAS;
}
