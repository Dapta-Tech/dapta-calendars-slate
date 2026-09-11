import { Skeleton } from '@/components/skeleton';

export default function AvailabilityLoading() {
  return (
    <div className="mx-auto max-w-[1520px] px-gutter py-section sm:px-gutter-wide sm:py-gutter-y">
      <Skeleton className="mb-tight h-9 w-56" />
      <Skeleton className="mb-group h-4 w-96" />
      {/* Schedule-card shaped: header row + 7 weekday rows. */}
      <div className="rounded-md border border-border bg-card p-card">
        <div className="mb-card flex items-center justify-between">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-8 w-64" />
        </div>
        <div className="flex flex-col gap-field">
          {Array.from({ length: 7 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}
