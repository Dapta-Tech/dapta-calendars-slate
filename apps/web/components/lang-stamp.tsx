'use client';

import { useEffect, useLayoutEffect, useRef } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import type { Locale } from '@slate/shared';
import { documentLangFor } from '@/lib/document-lang';

/**
 * Keeps `<html lang>` honest across CLIENT navigations, the way `ThemeStamp`
 * keeps `data-theme` honest.
 *
 * The root layout stamps the attribute per request, which is what a crawler and
 * a full load see. But `<html>` belongs to the root layout, which the App Router
 * does not re-render on a soft navigation, so a `<Link>` that crosses between
 * the product and a booking page (the OSS landing's demo link, the not-found
 * page's way home) would carry the other side's language with it.
 *
 * The two answers the language is decided from do not change from page to page
 * (the admin's saved or browser language, the visitor's browser language), so
 * the server hands them over once and this re-applies the server's own rule,
 * `documentLangFor`, to each route. Changing the saved language is a server
 * action that re-renders the root layout, which hands over the new answer.
 *
 * The first run is a full load the server already stamped, so it writes
 * nothing. A LAYOUT effect, so the new language lands in the same commit as the
 * new page; the shim keeps it quiet during SSR, as in `ThemeStamp`.
 */
const useBeforePaint = typeof window === 'undefined' ? useEffect : useLayoutEffect;

export function LangStamp({ product, visitor }: { product: Locale; visitor: Locale }) {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  const first = useRef(true);

  useBeforePaint(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const want = documentLangFor(pathname, search, { product, visitor });
    if (document.documentElement.lang !== want) document.documentElement.lang = want;
  }, [pathname, search, product, visitor]);

  return null;
}
