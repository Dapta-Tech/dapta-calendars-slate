import { Skeleton } from '@/components/skeleton';

export default function BookingsLoading() {
  return (
    <div className="mx-auto max-w-[1520px] px-gutter py-section sm:px-gutter-wide sm:py-gutter-y">
      <Skeleton className="mb-group h-9 w-40" />
      <Skeleton className="mb-field h-4 w-56" />
      <div className="flex flex-col gap-inline">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-[68px] w-full" />
        ))}
      </div>
    </div>
  );
}
