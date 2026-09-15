import { Skeleton } from '@/components/skeleton';

export default function SettingsLoading() {
  return (
    // Same gutters and the same 44px tab height as the real chrome, so the page
    // does not jump when the skeleton is replaced.
    <div className="mx-auto max-w-5xl px-gutter py-section sm:px-gutter-wide sm:py-gutter-y">
      <Skeleton className="mb-tight h-9 w-40" />
      <Skeleton className="mb-group h-4 w-full max-w-72" />
      <div className="mb-group flex gap-inline overflow-hidden">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-11 w-24 shrink-0" />
        ))}
      </div>
      <Skeleton className="h-72 w-full max-w-2xl rounded-xl" />
    </div>
  );
}
