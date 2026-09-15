import { Skeleton } from '@/components/skeleton';

export default function TeamsLoading() {
  return (
    <div className="mx-auto max-w-[1520px] px-gutter py-section sm:px-gutter-wide sm:py-gutter-y">
      <Skeleton className="mb-tight h-9 w-32" />
      <Skeleton className="mb-group h-4 w-72" />
      <div className="flex flex-col gap-field">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-[72px] w-full" />
        ))}
      </div>
    </div>
  );
}
