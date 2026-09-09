'use client';

import { useEffect, useLayoutEffect } from 'react';
import { usePathname } from 'next/navigation';
import { BOOKING_CANVAS } from '@/lib/booking-canvas';
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
 * This closes the class rather than that one link, and it answers with the same
 * rule the server does: the route decides. It re-derives on every pathname
 * change and only writes when the answer differs, so it is inert on a hard load
 * (where the server already got it right) and on navigation inside one surface.
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

  useBeforePaint(() => {
    // The public branch reads no cookie at all — the whole point.
    const want: Theme = isProductPath(pathname)
      ? (cookieTheme() ?? PRODUCT_THEME_DEFAULT)
      : BOOKING_CANVAS;
    if (document.documentElement.dataset.theme !== want) {
      document.documentElement.dataset.theme = want;
    }
  }, [pathname]);

  return null;
}
