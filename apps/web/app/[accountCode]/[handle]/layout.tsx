import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { getProfile } from '@/lib/api';

/**
 * A host's pages exist only if the host does, and that is decided HERE, above
 * every loading boundary below it, so a link that leads nowhere answers a real
 * `404` instead of a `200` with a not-found page streamed inside it. A layout
 * runs before its segment's `loading.tsx` is sent, which is why the check is
 * not left to the pages alone (they keep theirs, for the redirect logic).
 *
 * Free: `getProfile` is `cache()`d per request, and for any well-formed booking
 * path the root layout has already awaited this same read to stamp the page's
 * theme (`resolveDocumentTheme`), so nothing new sits on the path to the first
 * byte.
 */
export default async function HostLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ accountCode: string; handle: string }>;
}) {
  const { accountCode, handle } = await params;
  if (!(await getProfile(accountCode, handle))) notFound();
  return children;
}
