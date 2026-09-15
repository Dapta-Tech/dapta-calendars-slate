import { cookies, headers } from 'next/headers';
import { DEFAULT_BOOKING_CANVAS, bookingCanvasOf } from '@/lib/booking-canvas';
import { getProfile } from '@/lib/api';
import { parseEmbedParams, searchParamsFromQuery } from '@/lib/embed';
import {
  PATH_HEADER,
  PRODUCT_THEME_DEFAULT,
  QUERY_HEADER,
  THEME_COOKIE,
  isProductPath,
  parseTheme,
  type Theme,
} from '@/lib/theme';

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
 * The two path shapes that carry a STORED theme: `/{accountCode}/{handle}` and
 * `/{accountCode}/{handle}/{slug}`. A trailing slash is tolerated because a
 * pasted link often has one.
 *
 * The event slug is matched but NOT captured: both routes read the same member's
 * style, so which event is being booked cannot change the canvas.
 */
const HOST_PAGE_PATH = /^\/([^/]+)\/([^/]+)(?:\/[^/]+)?\/?$/;

/**
 * The alphabet an account code or a handle is drawn from. Anything else is not a
 * booking page and must not be turned into an API path.
 *
 * No DOT, deliberately. Short codes are `SHORT_CODE_ALPHABET` (lowercase
 * alphanumeric), and both vanity slugs and handles are `[a-z0-9-]` — none of the
 * three can contain one. Allowing it would admit a segment that decodes to `..`,
 * and `getProfile` builds its URL with `encodeURIComponent`, which does not
 * escape a dot: `/v1/profiles/../{handle}` is a different endpoint once `fetch`
 * normalises it. A real code that somehow failed this test costs the page its
 * stored canvas and nothing else, which is the right way to be wrong.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * The style object a public path's page will render with, or null when the path
 * has none to read.
 *
 * Only the two PERSONAL routes store a style. `/manage/{uid}` and both team
 * routes hold no branding in the model at all, so they answer with the ADR
 * default — and they are excluded by NAME rather than by shape because both
 * names collide with this regex (`/manage/{uid}` is two segments; a team event
 * is three). `manage` and `team` are in the engine's `RESERVED_PUBLIC_SLUGS`,
 * which is what makes the exclusion safe: no account code can be `manage` and
 * no handle can be `team`, so a real host page can never be mistaken for one.
 */
async function storedBookingStyle(path: string): Promise<Record<string, unknown> | null> {
  const match = HOST_PAGE_PATH.exec(path);
  if (!match) return null;
  try {
    const accountCode = decodeURIComponent(match[1]!);
    const handle = decodeURIComponent(match[2]!);
    // Shape-checked AFTER decoding, because that is where the danger is: the
    // segments are concatenated into an API path by a `encodeURIComponent` that
    // does not escape `.`, so a segment decoding to `..` would walk out of
    // `/v1/profiles/` and `fetch()` would normalise it into a different
    // endpoint. An account code or handle is this alphabet or it is not one.
    if (!SAFE_SEGMENT.test(accountCode) || !SAFE_SEGMENT.test(handle)) return null;
    if (accountCode === 'manage' || handle === 'team') return null;
    // `cache()`d, so this is the SAME fetch `generateMetadata` and the page
    // make — one profile read per request, not three.
    const profile = await getProfile(accountCode, handle);
    return (profile?.member.style ?? null) as Record<string, unknown> | null;
  } catch {
    // A malformed escape, or an API that is down. Neither is a reason to fail
    // the document: the page has its own error handling and will run it on the
    // default canvas.
    return null;
  }
}

/**
 * The theme to stamp on `<html>` for THIS request.
 *
 * Two branches that cannot read each other's source, which is what makes ADR
 * 0004's rule structural rather than a convention someone has to remember:
 *
 *  - a PRODUCT route answers with the host's cookie;
 *  - a PUBLIC route answers with the booking page's OWN `theme` style axis,
 *    which has nothing to do with the cookie, resolved through the same
 *    `bookingCanvasOf` the branding engine derives the host's accent tokens
 *    against. The ground a page paints on and the ground its hover, wash and
 *    contrast readout are computed against are one fact, resolved in one
 *    module, so they move together.
 *
 * ── WHY THE DOCUMENT RESOLVES THIS AND NOT ONLY THE SHELL (B2's design call) ──
 *
 * `<html>` belongs to the root layout, no nested layout can restamp it, and the
 * root layout is handed neither the path nor the params of the page rendering
 * under it. The alternative was to let `BrandedShell` own the canvas alone and
 * have this function keep answering with a constant (the ADR default). That was
 * rejected, for one reason that is not a matter of taste: everything OUTSIDE the
 * shell would then paint on the wrong ground. The event routes have a
 * `loading.tsx`, which is exactly what an invitee sees first on a hard load —
 * a light skeleton handing over to a dark page is a flash of the wrong canvas on
 * the highest-traffic surface in the product. `not-found`, the public error
 * boundary and `/manage/{uid}` (which renders no shell at all) sit outside it
 * too, as do the browser's own `color-scheme` chrome and the overscroll canvas.
 *
 * So the path travels as a header and the page's own loader answers. The costs,
 * stated so the next reader can weigh them rather than rediscover them:
 *
 *  - The document shell now awaits one profile read on a personal booking route.
 *    It is `cache()`d and the page awaits the same one, so it is one fetch per
 *    request, not a new round trip — but it is on the critical path to the
 *    skeleton, which it was not before.
 *  - This function knows two path SHAPES. A future public route that stores its
 *    own theme has to be added here, and the failure if it is not is graceful:
 *    the shell still stamps the right canvas on itself, and only the ground
 *    behind it falls back to the default.
 *
 * `BrandedShell` stamps its subtree regardless, and that is not redundancy: the
 * studio preview renders the invitee's page inside the ADMIN's document, where
 * `<html>` answers to the host's cookie and must. Subtree stamping is the only
 * mechanism that can be right on both surfaces, which is why it is the one the
 * preview == prod contract rests on.
 *
 * A MISSING path header resolves to the public branch, not the product one. The
 * middleware's matcher covers every page request so this should not happen; if
 * it ever does, failing this way means the admin quietly ignores the toggle —
 * visible immediately — rather than the cookie leaking onto a booking page,
 * which is the thing the ADR forbids and the thing nobody would spot.
 */
export async function resolveDocumentTheme(): Promise<Theme> {
  const head = await headers();
  const path = head.get(PATH_HEADER);
  if (path !== null && isProductPath(path)) return getProductTheme();

  // The embed override outranks the stored axis, and is read by the routes'
  // own parser: an unknown value is dropped there rather than raised, so one
  // typo in a pasted snippet costs this axis and never the page (#67).
  const override = parseEmbedParams(searchParamsFromQuery(head.get(QUERY_HEADER))).style.theme;
  if (override === 'dark' || override === 'light') return override;

  if (path === null) return DEFAULT_BOOKING_CANVAS;
  return bookingCanvasOf(await storedBookingStyle(path));
}
