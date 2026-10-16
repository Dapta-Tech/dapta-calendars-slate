import { Skeleton } from '@/components/skeleton';

/** The booking page's shape while it loads: the header, then the booking's card. */
export default function BookingLoading() {
  return (
    <div className="mx-auto max-w-[1520px] px-gutter pb-gutter-y pt-group sm:px-gutter-wide">
      <Skeleton className="mb-inline h-5 w-24" />
      <Skeleton className="mb-group h-8 w-64 max-w-full" />
      <Skeleton className="h-16 w-full" />
    </div>
  );
}
