import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { getTeamProfile } from '@/lib/api';

/**
 * The event half of the team layout's check: an event the team does not list
 * is a real `404`, decided before the team event page's `loading.tsx`.
 */
export default async function TeamEventLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ accountCode: string; teamSlug: string; slug: string }>;
}) {
  const { accountCode, teamSlug, slug } = await params;
  const team = await getTeamProfile(accountCode, teamSlug);
  if (!team?.eventTypes.some((e) => e.slug === slug)) notFound();
  return children;
}
