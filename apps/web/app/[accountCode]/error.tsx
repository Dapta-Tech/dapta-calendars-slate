'use client';

import { getMessages } from '@slate/shared';
import { useVisitorLocale } from '@/lib/use-visitor-locale';
import { useErrorReport } from '@/lib/analytics/use-error-report';

/**
 * R22 error boundary for the public booking subtree: a real Retry, no dead end.
 * A busy service never lands here (the pages render their own busy notice), so
 * this is a genuine failure on our side, and it says so in the visitor's
 * language without naming anything internal.
 */
export default function PublicError({ error, reset }: { error: Error; reset: () => void }) {
  useErrorReport(error, 'booking_page');
  const copy = getMessages(useVisitorLocale()).trouble;
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-2xl font-semibold">{copy.pageTitle}</h1>
      <p className="text-muted-foreground">{copy.pageBody}</p>
      <button
        type="button"
        onClick={reset}
        className="rounded-md bg-primary px-5 py-2 font-semibold text-primary-foreground transition-transform active:scale-[0.98]"
      >
        {copy.tryAgain}
      </button>
    </main>
  );
}
