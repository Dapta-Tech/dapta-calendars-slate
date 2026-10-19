import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { getProfile } from '@/lib/api';
import { requestPathSegment } from '@/lib/request-path';

/**
 * A host's pages exist only if the host does, and an event page only if the
 * host lists that event publicly. Both are decided HERE, above every loading
 * boundary below, so a link that leads nowhere answers a real `404` instead of
 * a `200` with a not-found page streamed inside it. A layout runs before its
 * segment's `loading.tsx` is sent, which is why the check is not left to the
 * pages alone (they keep theirs, for client navigations and the redirects).
 *
 * The event is checked here rather than in a layout of its own because of
 * prefetching: a production `<Link>` to an event renders the route down to the
 * event's `loading.tsx`, so a layout between the two would cost one API read
 * per event link a profile shows, per visitor. This layout is shared by the
 * profile and its events, so the router keeps it across that navigation and a
 * prefetch never runs it. A layout is not handed its children's params, so the
 * slug comes from the request's own path (`requestPathSegment`); on a client
 * navigation, where this layout does not run, the event page's own
 * `notFound()` answers, and there is no status line to get right.
 *
 * Free on a full load: `getProfile` is `cache()`d per request, and for any
 * well-formed booking path the root layout has already awaited this same read
 * to stamp the page's theme (`resolveDocumentTheme`). The public listing is the
 * same existence test the event page and the availability route use; hidden
 * events are reached only through `/booking/{token}`.
 */
export default async function HostLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ accountCode: string; handle: string }>;
}) {
  const { accountCode, handle } = await params;
  const profile = await getProfile(accountCode, handle);
  if (!profile) notFound();
  // `/{accountCode}/{handle}/{slug}`: the third segment, when there is one.
  const slug = await requestPathSegment(2);
  if (slug !== null && !profile.eventTypes.some((e) => e.slug === slug)) notFound();
  return children;
}
