'use client';

export default function AdminError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="mx-auto max-w-md px-gutter py-16 text-center sm:px-gutter-wide">
      <h1 className="mb-inline text-2xl font-semibold">Couldn’t load this section</h1>
      <p className="mb-card text-muted-foreground">
        The API may be unreachable. Check it’s running, then retry.
      </p>
      <button
        type="button"
        onClick={reset}
        className="rounded-md bg-primary px-control-pad py-inline font-semibold text-primary-foreground transition-transform active:scale-[0.98]"
      >
        Retry
      </button>
    </div>
  );
}
