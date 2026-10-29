'use client';

import { useSearchParams } from 'next/navigation';
import type { Locale } from '@slate/shared';

/**
 * The visitor's language on a client-only surface that has no locale handed
 * to it (an error boundary): an explicit `?lang=` wins, else English, the same
 * rule `publicLocale` applies on the server. The browser's own language is not
 * consulted: Spanish only by explicit choice.
 */
export function useVisitorLocale(): Locale {
  const lang = useSearchParams()?.get('lang');
  return (lang ?? '').trim().toLowerCase().startsWith('es') ? 'es' : 'en';
}
