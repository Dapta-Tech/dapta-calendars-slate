'use client';

import { useEffect, useRef } from 'react';
import type { Locale } from '@slate/shared';
import { syncLocaleAction } from '@/app/admin/locale-actions';

/**
 * Records the dashboard's language as the host's own, once, while they have
 * none on record (`member.locale` is null). Without it a host who never touched
 * the language switch has no language, and their booking link's preview falls
 * back to English for every chat that shows it. Renders nothing; a no-op once
 * the host has a language, and the API never overwrites one either.
 */
export function LocaleSync({ currentLocale, locale }: { currentLocale: string | null; locale: Locale }) {
  const sent = useRef(false);

  useEffect(() => {
    if (sent.current || currentLocale) return;
    sent.current = true;
    void syncLocaleAction(locale);
  }, [currentLocale, locale]);

  return null;
}
