import { cookies, headers } from 'next/headers';
import type { Locale } from '@slate/shared';
import { documentLangFor, langFromQuery } from '@/lib/document-lang';
import { PATH_HEADER, QUERY_HEADER } from '@/lib/theme';

/** Persisted admin-UI language choice (F8 parity with the old app's toggle). */
export const LOCALE_COOKIE = 'slate_locale';

const SUPPORTED: readonly Locale[] = ['en', 'es'];

/**
 * The best supported language in an `Accept-Language` header, or English.
 *
 * Weights are honored, so `fr-FR, es;q=0.8, en;q=0.5` answers Spanish: the
 * reader prefers Spanish over English even though neither is their first
 * choice. Between equal weights the earlier tag wins, as the header orders them.
 * A tag weighted `q=0` is a refusal and never chosen; a weight that cannot be
 * read is ignored rather than taken as one. Anything unreadable, or a
 * header that names neither language, is English, so a bare request renders
 * exactly as it always has.
 */
export function negotiateLocale(header: string | null | undefined): Locale {
  let best: { locale: Locale; q: number } | null = null;
  for (const part of (header ?? '').split(',')) {
    const [rawTag, ...params] = part.split(';');
    const primary = rawTag?.trim().toLowerCase().split('-')[0];
    const locale = SUPPORTED.find((l) => l === primary);
    if (!locale) continue;
    const qParam = params.map((p) => p.trim().toLowerCase()).find((p) => p.startsWith('q='));
    // An unreadable weight (`q=`, `q=abc`) is ignored, not read as a refusal:
    // only a weight that says 0 turns a language down.
    const raw = qParam?.slice(2).trim() ?? '';
    const parsed = raw === '' ? NaN : Number(raw);
    const q = Number.isFinite(parsed) ? parsed : 1;
    if (q <= 0) continue;
    if (!best || q > best.q) best = { locale, q };
  }
  return best?.locale ?? 'en';
}

/**
 * The admin surface's locale: the language the switcher saved, else the
 * browser's own, so a Spanish speaker's first sign-in and onboarding are in
 * Spanish before they ever find the switch. English when neither says.
 */
export async function getLocale(): Promise<Locale> {
  const chosen = (await cookies()).get(LOCALE_COOKIE)?.value;
  if (chosen === 'en' || chosen === 'es') return chosen;
  return negotiateLocale((await headers()).get('accept-language'));
}

/**
 * Public-surface locale (no admin cookie there): an explicit `?lang=` wins,
 * otherwise the browser's Accept-Language decides. Defaults to English.
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
  return negotiateLocale(head.get('accept-language'));
}

/**
 * The two answers a document's language is decided from, which hold for every
 * page of this request's browser: the admin's (`getLocale`) and the visitor's
 * browser language. Handed to `LangStamp` once, so a client navigation can
 * re-apply the same rule the server did.
 */
export async function documentLangAnswers(): Promise<{ product: Locale; visitor: Locale }> {
  const [product, head] = await Promise.all([getLocale(), headers()]);
  return { product, visitor: negotiateLocale(head.get('accept-language')) };
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
