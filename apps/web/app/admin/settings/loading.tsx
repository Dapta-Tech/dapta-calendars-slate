import { Skeleton } from '@/components/skeleton';

export default function SettingsLoading() {
  return (
    // Same gutters and the same 44px tab height as the real chrome, so the page
    // does not jump when the skeleton is replaced.
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-8 sm:py-10">
      <Skeleton className="mb-1 h-9 w-40" />
      <Skeleton className="mb-6 h-4 w-full max-w-72" />
      <div className="mb-6 flex gap-2 overflow-hidden">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-11 w-24 shrink-0" />
        ))}
      </div>
      <Skeleton className="h-72 w-full max-w-2xl rounded-xl" />
    </div>
  );
}
