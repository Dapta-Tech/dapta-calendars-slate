import { SkeletonList } from '@/components/skeleton';

/**
 * The generic page skeleton (R22): a heading bar over a few rows. It used to be
 * the ROOT `app/loading.tsx`, and that is exactly why it moved: a root loading
 * boundary commits every response to `200 OK` before any page below it runs, so
 * a booking link that leads nowhere answered 200 with a not-found page inside it
 * (a soft 404). The routes that still want it, and have no existence question a
 * search engine cares about, now render it from their own `loading.tsx`.
 *
 * Spacing by role (the spacing gate scans this folder): the page's own vertical
 * gutter, which is also where the manage page's content starts.
 */
export function PageSkeleton() {
  return (
    <main className="mx-auto max-w-2xl px-group py-gutter-y">
      <div className="mb-section h-9 w-48 animate-pulse rounded-md bg-muted" />
      <SkeletonList rows={3} />
    </main>
  );
}
