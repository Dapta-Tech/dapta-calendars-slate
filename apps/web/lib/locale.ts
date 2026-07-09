import { cookies } from 'next/headers';
import type { Locale } from '@slate/shared';

/** Persisted admin-UI language choice (F8 parity with the old app's toggle). */
export const LOCALE_COOKIE = 'slate_locale';

/**
 * The admin surface's locale, read from the persisted cookie the language
 * switcher writes. Defaults to English so a bare fork renders with no cookie.
 */
export async function getLocale(): Promise<Locale> {
  const jar = await cookies();
  return jar.get(LOCALE_COOKIE)?.value === 'es' ? 'es' : 'en';
}
