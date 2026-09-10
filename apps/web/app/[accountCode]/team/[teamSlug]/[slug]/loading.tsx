import { Skeleton } from '@/components/skeleton';

/**
 * The team event page's skeleton (BP) — panel, month, day column, at the same
 * breakpoints as the real grid so the page does not visibly re-lay-out the
 * moment the slots arrive.
 *
 * The team route had no `loading.tsx` at all; with both routes now rendering
 * the same layout, the personal one having a skeleton and this one having none
 * is a difference with no reason behind it.
 */
export default function TeamBookingLoading() {
  return (
    <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-12">
      {/* `bp-canvas` too, not just the outer `max-w-6xl`: the canvas caps at
          64rem, so without it the skeleton stands 8rem wider than the page it
          stands in for and the layout jumps the moment slots arrive. */}
      <div className="bp-canvas grid gap-6 md:grid-cols-2 lg:grid-cols-[16rem_minmax(0,1fr)_17rem] lg:gap-8">
        {/* Event panel */}
        <div className="flex flex-col gap-4 md:col-span-2 lg:col-span-1">
          <div className="flex items-center gap-3">
            <Skeleton className="h-11 w-11 rounded-full" />
            <Skeleton className="h-4 w-28" />
          </div>
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-11 w-full" />
        </div>

        {/* Month calendar */}
        <div className="flex flex-col gap-3">
          <Skeleton className="h-5 w-36" />
          <div className="grid grid-cols-7 gap-1">
            {Array.from({ length: 35 }).map((_, i) => (
              <Skeleton key={i} className="aspect-square h-auto w-full" />
            ))}
          </div>
        </div>

        {/* Day column */}
        <div className="flex flex-col gap-3">
          <Skeleton className="h-5 w-32" />
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-11 w-full" />
          ))}
        </div>
      </div>
    </main>
  );
}
