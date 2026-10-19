import { Skeleton } from '@/components/skeleton';

export default function DevelopersLoading() {
  return (
    // The frame `DeveloperPage` draws (same width, gutters and header rhythm),
    // so nothing jumps when the page replaces it.
    <div className="mx-auto max-w-5xl px-gutter py-section sm:px-gutter-wide sm:py-gutter-y">
      <Skeleton className="mb-tight h-9 w-56" />
      <Skeleton className="mb-group h-4 w-full max-w-prose" />
      <div className="flex max-w-3xl flex-col gap-section">
        <Skeleton className="h-96 w-full rounded-xl" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    </div>
  );
}
