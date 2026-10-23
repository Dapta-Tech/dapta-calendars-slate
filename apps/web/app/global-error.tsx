'use client';

import { useSyncExternalStore } from 'react';
import { getMessages, type Locale } from '@slate/shared';
import { useErrorReport } from '@/lib/analytics/use-error-report';
import './globals.css';

const subscribe = () => () => undefined;

/**
 * The reader's language from the browser alone: this boundary replaces the
 * root layout, so nothing the server resolved reaches it. English on the
 * server render and the first paint, so hydration never mismatches.
 */
function useBrowserLocale(): Locale {
  const language = useSyncExternalStore(
    subscribe,
    () => (typeof navigator !== 'undefined' ? navigator.language : ''),
    () => '',
  );
  return language.trim().toLowerCase().startsWith('es') ? 'es' : 'en';
}

/**
 * The last boundary: what renders when the root layout itself fails. It
 * replaces the whole document, so it brings its own `<html>`, `<body>` and
 * styles. R22: a real Retry, which asks the server again (a root layout
 * failure is almost always the server's), never a dead end.
 */
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useErrorReport(error, 'global');
  const locale = useBrowserLocale();
  const copy = getMessages(locale).trouble;
  return (
    <html lang={locale}>
      <body className="min-h-dvh bg-background text-foreground">
        <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
          <h1 className="text-2xl font-semibold">{copy.pageTitle}</h1>
          <p className="text-muted-foreground">{copy.pageBody}</p>
          <button
            type="button"
            onClick={() => retry()}
            className="rounded-md bg-primary px-5 py-2 font-semibold text-primary-foreground transition-transform active:scale-[0.98]"
          >
            {copy.tryAgain}
          </button>
        </main>
      </body>
    </html>
  );
}
