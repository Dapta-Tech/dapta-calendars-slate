'use client';

import { getMessages } from '@slate/shared';
import { useVisitorLocale } from '@/lib/use-visitor-locale';

/**
 * R22 error boundary for the manage-booking subtree. The visitor came from an
 * email about a booking they made, so the first thing it says is that the
 * booking itself is unaffected, then what to do. Retry asks the server again
 * (`retry`), so a failure that has passed clears.
 */
export default function ManageError({ retry }: { error: Error; retry: () => void }) {
  const copy = getMessages(useVisitorLocale()).trouble;
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-2xl font-semibold">{copy.manageTitle}</h1>
      <p className="text-muted-foreground">{copy.manageBody}</p>
      <button
        type="button"
        onClick={() => retry()}
        className="rounded-md bg-primary px-5 py-2 font-semibold text-primary-foreground transition-transform active:scale-[0.98]"
      >
        {copy.tryAgain}
      </button>
    </main>
  );
}
