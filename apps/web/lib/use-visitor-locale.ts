'use client';

import { useSyncExternalStore } from 'react';
import { useSearchParams } from 'next/navigation';
import type { Locale } from '@slate/shared';

const subscribe = () => () => undefined;

/**
 * The visitor's language on a client-only surface that has no locale handed
 * to it (an error boundary): an explicit `?lang=` wins, else the browser's
 * language, the same two signals `publicLocale` reads on the server. English
 * on the server render and the first paint, so hydration never mismatches.
 */
export function useVisitorLocale(): Locale {
  const lang = useSearchParams()?.get('lang');
  const browser = useSyncExternalStore(
    subscribe,
    () => (typeof navigator !== 'undefined' ? navigator.language : ''),
    () => '',
  );
  const pick = lang || browser;
  return pick.trim().toLowerCase().startsWith('es') ? 'es' : 'en';
}
