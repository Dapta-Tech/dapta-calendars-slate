import type { Locale } from '@slate/shared';
import { isProductPath } from '@/lib/theme';

/**
 * Which language a document is in, as a pure rule both halves share: the
 * server (`lib/locale.ts`, which stamps `<html lang>` on a full load) and
 * `LangStamp` (which keeps it right across client navigations). No
 * `next/headers` here, so the browser can import it.
 */

/** A `?lang=` value: anything that starts with `es` is Spanish, the rest English. */
export function langFromQuery(value: string): Locale {
  return value.trim().toLowerCase().startsWith('es') ? 'es' : 'en';
}

/**
 * The language a path is rendered in, given the two answers that do not change
 * from one page to the next: the admin's (`product`: their saved choice, else
 * their browser's) and the visitor's (`visitor`: their browser's). A public
 * page's `?lang=` outranks the visitor's browser, as `publicLocale` decides.
 */
export function documentLangFor(
  path: string,
  search: string,
  answers: { product: Locale; visitor: Locale },
): Locale {
  if (isProductPath(path)) return answers.product;
  const lang = new URLSearchParams(search).get('lang');
  return lang ? langFromQuery(lang) : answers.visitor;
}
