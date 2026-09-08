import type { BrandCanvas } from '@slate/shared';

/**
 * The ground every branded surface currently paints on.
 *
 * ADR 0004 gives the booking page a tenth style axis, `theme: 'dark' | 'light'`,
 * defaulting to `light` — set by the host in the studio, overridable per-embed,
 * and never inherited from the host's own admin preference. That axis is slice
 * B2. Until it lands there is exactly one canvas, and it is the dark one the
 * page has always rendered on, so no live page moves on the day B1 ships.
 *
 * It lives in one module rather than as a literal at each call site for the
 * reason the ADR gives: the studio renders a live preview and that preview IS
 * production. The public shell and the preview reading the same constant is
 * what makes them unable to disagree — B2 replaces this with a lookup on the
 * stored axis, in one place, and both surfaces move together.
 *
 * NOTE FOR B2 — the accent tokens are not the whole job. The studio's preview
 * container emits only the branding vars and inherits `--background`, `--card`
 * and `--foreground` from the admin shell, which the root layout pins to dark.
 * That is why one canvas is enough today. The moment a host can put their page
 * on the light canvas, the preview has to stamp that canvas's `data-theme` and
 * surface tokens as well — `--accent-wash` composites against `--background`,
 * so otherwise the preview's wash and card grounds diverge from the real page's
 * while the accent itself matches, which is the harder version of the same bug.
 */
export const BOOKING_CANVAS: BrandCanvas = 'dark';
