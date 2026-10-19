import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { getTeamProfile } from '@/lib/api';

/**
 * A team's pages exist only if the team does: a real `404` for one that does
 * not, decided above every loading boundary (see the host layout for why).
 *
 * The cost, stated: this read is the team landing's only data, so its skeleton
 * could not show before the read without committing the response to `200`
 * first. The landing now paints when that read lands, the moment its content
 * was ready before; the instant skeleton in front of it is what went. The read
 * is `cache()`d, so the pages below and their metadata share it.
 */
export default async function TeamLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ accountCode: string; teamSlug: string }>;
}) {
  const { accountCode, teamSlug } = await params;
  if (!(await getTeamProfile(accountCode, teamSlug))) notFound();
  return children;
}
