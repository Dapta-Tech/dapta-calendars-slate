import { Skeleton } from '@/components/skeleton';

export default function EventTypesLoading() {
  return (
    <div className="mx-auto max-w-[1520px] px-gutter py-section sm:px-gutter-wide sm:py-gutter-y">
      <Skeleton className="mb-group h-9 w-48" />
      <div className="mb-section flex flex-col gap-inline">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
