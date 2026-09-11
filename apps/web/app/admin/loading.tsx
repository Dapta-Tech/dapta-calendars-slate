import { SkeletonList } from '@/components/skeleton';

export default function AdminLoading() {
  return (
    <div className="mx-auto max-w-4xl px-gutter py-section sm:px-gutter-wide sm:py-gutter-y">
      <div className="mb-group h-9 w-56 animate-pulse rounded-md bg-muted" />
      <SkeletonList rows={4} />
    </div>
  );
}
