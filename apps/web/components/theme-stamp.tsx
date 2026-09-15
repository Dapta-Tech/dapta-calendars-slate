'use client';

import { useEffect, useLayoutEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { DEFAULT_BOOKING_CANVAS } from '@/lib/booking-canvas';
import { PRODUCT_THEME_DEFAULT, THEME_COOKIE, isProductPath, parseTheme, type Theme } from '@/lib/theme';

/**
 * Keeps `data-theme` honest across CLIENT navigations.
 *
 * The root layout stamps the attribute per request, which is what makes the
 * first paint correct with no flash. But `<html>` belongs to the root layout,
 * and the App Router does not re-render a shared layout on a soft navigation —
 * the element and its attributes are committed once and then preserved. So a
 * `<Link>` that crosses from the product into a booking page carries the host's
 * product theme with it, and that is precisely the leak ADR 0004 forbids: the
 * OSS landing links straight at the demo booking page, so a host on light could
 * reach a light booking page without the studio ever saying so.
 *
 * ── WHAT THIS OWNS, AND WHAT IT DELIBERATELY DOES NOT ──────────────────────
 *
 * It owns ONE question: is the host's product cookie on `<html>` when it has no
 * business being there? So it writes in exactly two situations — a product route
 * (answer with the cookie) and the CROSSING from a product route onto a public
 * one (answer with the ADR default, immediately, so the cookie is gone in the
 * same commit the `<Link>` lands).
 *
 * It does NOT answer with the booking page's own canvas, and that is the fix for
 * a bug this file had: on a soft navigation the effect can fire in a commit
 * where the destination is a Suspense fallback — every public route has a
 * `loading.tsx` — so the new page's shell is not in the DOM to read a canvas
 * off, `usePathname` has ALREADY changed, and the effect never runs again. Any
 * guess it made there would be a wrong answer written over a correct one, not a
 * fallback. `CanvasStamp`, rendered by each public route with the canvas the
 * SERVER resolved, is what answers that question; it cannot run before its page
 * exists, so it is never early and never wrong.
 *
 * Public-to-public navigation is therefore left alone entirely: no cookie can
 * have leaked, and the destination's own `CanvasStamp` is already on its way.
 *
 * A LAYOUT effect, not a passive one: it must land in the same commit as the new
 * page, before the browser paints, or crossing into a booking page shows a frame
 * of the wrong palette. `useLayoutEffect` warns when it runs during SSR, and
 * this component renders on the server like any other — hence the shim.
 */
const useBeforePaint = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** The theme cookie as the browser holds it. Absent, blocked or malformed all
 *  read the same way — as "no preference expressed". Split rather than matched,
 *  so the name comes from the shared constant instead of a pattern that would
 *  have to escape the dot in it. */
function cookieTheme(): Theme | null {
  try {
    for (const part of document.cookie.split(';')) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      if (part.slice(0, eq).trim() !== THEME_COOKIE) continue;
      return parseTheme(decodeURIComponent(part.slice(eq + 1).trim()));
    }
    return null;
  } catch {
    return null;
  }
}

export function ThemeStamp() {
  const pathname = usePathname();
  // The route this effect last answered for. `null` on the first run, which is a
  // HARD load — the server already stamped that response correctly, so there is
  // nothing to correct and the public branch stays out of the way.
  const previous = useRef<string | null>(null);

  useBeforePaint(() => {
    const from = previous.current;
    previous.current = pathname;

    if (isProductPath(pathname)) {
      const want = cookieTheme() ?? PRODUCT_THEME_DEFAULT;
      if (document.documentElement.dataset.theme !== want) {
        document.documentElement.dataset.theme = want;
      }
      return;
    }

    // A public route. The only thing to do here is evict a product theme that
    // just rode in on a `<Link>` — the page's own canvas is `CanvasStamp`'s to
    // answer. The public branch reads no cookie at all, which is the point.
    if (from === null || !isProductPath(from)) return;
    if (document.documentElement.dataset.theme !== DEFAULT_BOOKING_CANVAS) {
      document.documentElement.dataset.theme = DEFAULT_BOOKING_CANVAS;
    }
  }, [pathname]);

  return null;
}
