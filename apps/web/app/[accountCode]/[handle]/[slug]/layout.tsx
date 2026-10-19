import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { getProfile } from '@/lib/api';

/**
 * The event half of the host layout's check: an event this host does not list
 * publicly is a real `404`, decided before the event page's `loading.tsx`
 * (which stays, as the skeleton a visitor sees on the way in from a profile).
 * The public listing is the same existence test the page and the availability
 * route use; hidden events are reached only through `/booking/{token}`.
 */
export default async function EventLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ accountCode: string; handle: string; slug: string }>;
}) {
  const { accountCode, handle, slug } = await params;
  const profile = await getProfile(accountCode, handle);
  if (!profile?.eventTypes.some((e) => e.slug === slug)) notFound();
  return children;
}
