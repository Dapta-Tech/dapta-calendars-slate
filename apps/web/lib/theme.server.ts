import { cookies, headers } from 'next/headers';
import { BOOKING_CANVAS } from '@/lib/booking-canvas';
import { PATH_HEADER, PRODUCT_THEME_DEFAULT, THEME_COOKIE, isProductPath, parseTheme, type Theme } from '@/lib/theme';

/**
 * Server-side theme resolution — the readers the root layout stamps from.
 *
 * Split from `theme.ts` because that module is also imported by the middleware
 * (edge runtime) and by a client island, neither of which may pull in
 * `next/headers`.
 */

/**
 * The host's product theme: their cookie, or the product default.
 *
 * Read on the SERVER so the first paint is already right. A client-side theme
 * guess flashes the wrong palette on every full load, on the one surface a host
 * looks at all day — the same reason `slate.nav.collapsed` is server-read.
 */
export async function getProductTheme(): Promise<Theme> {
  const jar = await cookies();
  return parseTheme(jar.get(THEME_COOKIE)?.value) ?? PRODUCT_THEME_DEFAULT;
}

/**
 * The theme to stamp on `<html>` for THIS request.
 *
 * Two branches that cannot read each other's source, which is what makes ADR
 * 0004's rule structural rather than a convention someone has to remember:
 *
 *  - a PRODUCT route answers with the host's cookie;
 *  - a PUBLIC route answers with the booking page's own canvas, which has
 *    nothing to do with the cookie. `BOOKING_CANVAS` is the same constant the
 *    branding engine clamps the host's accent against, and that is deliberate:
 *    the ground a page paints on and the ground its accent is made legible
 *    against are one fact, and B2 replaces the constant with the stored `theme`
 *    style axis in one place so both move together.
 *
 * A MISSING path header resolves to the public branch, not the product one. The
 * middleware's matcher covers every page request so this should not happen; if
 * it ever does, failing this way means the admin quietly ignores the toggle —
 * visible immediately — rather than the cookie leaking onto a booking page,
 * which is the thing the ADR forbids and the thing nobody would spot.
 */
export async function resolveDocumentTheme(): Promise<Theme> {
  const path = (await headers()).get(PATH_HEADER);
  if (path === null || !isProductPath(path)) return BOOKING_CANVAS;
  return getProductTheme();
}
