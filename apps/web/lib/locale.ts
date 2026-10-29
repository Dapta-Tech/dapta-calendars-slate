import { cookies, headers } from 'next/headers';
import type { Locale } from '@slate/shared';
import { documentLangFor, langFromQuery } from '@/lib/document-lang';
import { PATH_HEADER, QUERY_HEADER } from '@/lib/theme';

/** Persisted admin-UI language choice (F8 parity with the old app's toggle). */
export const LOCALE_COOKIE = 'slate_locale';

/**
 * The admin surface's locale: the language the switcher saved, else English.
 * The browser's Accept-Language is deliberately NOT consulted: English is the
 * default for a fresh visitor, and Spanish only ever comes from an explicit
 * choice (the switcher's cookie, or `?lang=`).
 */
export async function getLocale(): Promise<Locale> {
  const chosen = (await cookies()).get(LOCALE_COOKIE)?.value;
  if (chosen === 'en' || chosen === 'es') return chosen;
  return 'en';
}

/**
 * Public-surface locale (no admin cookie there): an explicit `?lang=` wins,
 * otherwise English. The browser's Accept-Language is not consulted.
 *
 * With no argument, `?lang=` is read from the request's own query, which the
 * middleware forwards as `QUERY_HEADER`. That is what lets the root layout
 * stamp `<html lang>` with the same answer the page renders in: the layout is
 * never handed the page's search params, and every public page asks this one
 * function.
 */
export async function publicLocale(lang?: string): Promise<Locale> {
  if (lang) return langFromQuery(lang);
  const head = await headers();
  const fromQuery = new URLSearchParams(head.get(QUERY_HEADER) ?? '').get('lang');
  if (fromQuery) return langFromQuery(fromQuery);
  return 'en';
}

/**
 * The two answers a document's language is decided from, which hold for every
 * page of this request's browser: the admin's (`getLocale`) and the visitor's
 * default (English: no browser sniffing). Handed to `LangStamp` once, so a client navigation can
 * re-apply the same rule the server did.
 */
export async function documentLangAnswers(): Promise<{ product: Locale; visitor: Locale }> {
  return { product: await getLocale(), visitor: 'en' };
}

/**
 * The language of THIS document, for `<html lang>` and the root metadata: the
 * admin's answer on a product route, the visitor's answer on a public one
 * (`documentLangFor`). Same boundary as the document theme (`isProductPath`),
 * and the same failure direction: a missing path header reads as public.
 */
export async function documentLocale(): Promise<Locale> {
  const head = await headers();
  return documentLangFor(
    head.get(PATH_HEADER) ?? '',
    head.get(QUERY_HEADER) ?? '',
    await documentLangAnswers(),
  );
}
