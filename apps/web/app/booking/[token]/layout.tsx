import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { getOneOffLink } from '@/lib/api';

/**
 * An unknown invite token is a missing route, answered with a real 404 BEFORE
 * this route's loading skeleton is sent, so it reads exactly like an unknown
 * host or event (see the page's header on #110: a guessed token must say
 * nothing about invite links existing). A used link is not this case: it
 * renders its own "this was used" state at 200, from the page. The read is
 * `cache()`d, so the page below reuses it.
 */
export default async function OneOffLinkLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const resolved = await getOneOffLink(token);
  if (!resolved.ok && resolved.reason === 'not-found') notFound();
  return children;
}
