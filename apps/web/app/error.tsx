'use client';

import { useErrorReport } from '@/lib/analytics/use-error-report';

/**
 * Root error boundary (R22: every error state has a real Retry). `retry`, not
 * `reset`: it asks the server again, so a failure that has passed (an API that
 * was down) clears instead of rendering the same failed payload.
 */
export default function Error({ error, retry }: { error: Error; retry: () => void }) {
  useErrorReport(error, 'root');
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-2xl font-semibold">Something went wrong</h1>
      <p className="text-muted-foreground">We couldn’t load this page. Please try again.</p>
      <button
        type="button"
        onClick={() => retry()}
        className="rounded-md bg-primary px-5 py-2 font-semibold text-primary-foreground transition-transform active:scale-[0.98]"
      >
        Try again
      </button>
    </main>
  );
}
