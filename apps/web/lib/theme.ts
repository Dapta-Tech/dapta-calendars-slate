/**
 * The product theme — the half of the token sheet a request is rendered on.
 *
 * This module is deliberately PURE: no `next/headers`, no server imports. It is
 * read by the middleware (edge runtime), by a client island (`ThemeToggle`) and
 * by the server layouts, and the only way one module can serve all three is to
 * hold nothing but constants and a predicate. The server-side readers live next
 * door in `theme.server.ts`.
 *
 * ADR 0004 is the reason any of this is more than one cookie read: the public
 * booking page's appearance is NEVER inherited from the host's own product
 * theme, and this app serves both surfaces from a single root layout.
 */
import type { BrandCanvas } from '@slate/shared';

/**
 * The two grounds the design language paints on.
 *
 * Aliased to the branding engine's `BrandCanvas` rather than re-declared as an
 * identical union: the document's theme and the ground a host's accent is
 * clamped against are the same fact, and since B2 a public route's answer IS
 * the stored `theme` style axis rather than a constant. A type-only import, so
 * nothing from the package reaches the middleware bundle.
 */
export type Theme = BrandCanvas;

/**
 * The host's product-theme preference.
 *
 * A DEVICE preference rather than a business fact (#70), so it is a cookie: no
 * schema, no migration, nothing account-scoped to audit. Dot-namespaced to sit
 * beside `slate.nav.collapsed`, the other bit of chrome state persisted per
 * device — `slate_locale` is a content choice and keeps its own older name.
 *
 * NOT `HttpOnly`, on purpose: `ThemeToggle` writes it from the client so the
 * flip is a repaint rather than a server round-trip, and a theme is not a
 * secret.
 */
export const THEME_COOKIE = 'slate.theme';

/** One year. A preference set once should not expire while it is still held. */
export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** The product default, from #70 — the design language is dark-first. */
export const PRODUCT_THEME_DEFAULT: Theme = 'dark';

/**
 * Request header the middleware tags every page request with.
 *
 * The App Router hands a layout its params, never its path, and the ROOT layout
 * is the one place a document theme can be stamped before paint. So the path has
 * to arrive as a header. It is set on the forwarded REQUEST headers, so it never
 * reaches the browser and an inbound header of the same name is overwritten
 * rather than trusted.
 */
export const PATH_HEADER = 'x-slate-path';

/**
 * Request header carrying the page request's QUERY STRING, `?` included.
 *
 * The same problem as `PATH_HEADER`, one step further out: a layout is handed
 * `params` and never `searchParams`, and B2's embed override (`?embed=1&theme=…`)
 * is a query parameter that changes the ground the document paints on. Without
 * it an embed pasted into a dark site would stamp `<html>` with the host's
 * stored canvas while the shell inside it paints the overridden one, and the
 * iframe's 700px pre-JS floor would show the difference as a band of the wrong
 * colour under a short page.
 *
 * Set on the forwarded REQUEST headers like the path, so it never reaches the
 * browser and an inbound header of this name is overwritten rather than trusted.
 */
export const QUERY_HEADER = 'x-slate-query';

/** A cookie value is a string from the client: anything unrecognised is not a
 *  theme, and must not be stamped into an attribute. */
export function parseTheme(value: string | undefined | null): Theme | null {
  return value === 'dark' || value === 'light' ? value : null;
}

/** Surfaces that are the PRODUCT — the console a signed-in host looks at.
 *  `/api` holds route handlers, which never render a layout; it is listed so an
 *  unmatched path under that namespace renders its 404 in the product's theme
 *  rather than on the booking canvas.
 *
 *  THIS ARRAY IS ALSO A SECURITY BOUNDARY. `lib/framing.ts` reads it to decide
 *  `frame-ancestors`, so removing an entry does not only change a palette — it
 *  opens that path to framing by any site, which is invisible on screen in a
 *  way the theming failure is not. `framing.spec.ts` pins every entry to
 *  `'self'` so a deletion breaks a test rather than a header. The reverse also
 *  holds: every prefix here must be an unclaimable vanity slug
 *  (`RESERVED_PUBLIC_SLUGS` in `@slate/engine`), or an account can serve a
 *  booking page from a path this list calls the product. */
const PRODUCT_PREFIXES = ['/admin', '/login', '/onboarding', '/api'];

/**
 * Product surface, or booking page?
 *
 * The product side is enumerated and everything else is public, rather than the
 * other way round, because the public routes are `/{accountCode}/{handle}/{slug}`
 * — dynamic segments that cannot be listed. That makes the default's failure mode
 * the harmless one: a future product route added at a new top-level path would
 * render on the booking canvas and ignore the toggle, which is visible the first
 * time anybody looks at the screen. The mirror-image default would leak the host's
 * cookie onto a booking page, which ADR 0004 forbids and which nobody notices.
 */
export function isProductPath(path: string): boolean {
  if (path === '/') return true;
  return PRODUCT_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}
