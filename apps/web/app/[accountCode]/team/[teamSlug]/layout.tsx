import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { getTeamProfile } from '@/lib/api';
import { isBusy, orBusy } from '@/lib/busy';
import { requestPathSegment } from '@/lib/request-path';

/**
 * A team's pages exist only if the team does, and a team event page only if
 * the team lists that event: a real `404` otherwise, decided above every
 * loading boundary, with the event read off the request's path for the same
 * prefetch reason the host layout gives.
 *
 * The cost, stated: unlike a person's pages, nothing awaited the team before
 * the first byte (the root layout reads no theme for a team), so this adds one
 * API read in front of the team landing AND the team event pages on a full
 * load. The read is the landing's only data, so the landing paints when it
 * lands, as its content did before, and its instant skeleton is what went; a
 * team event page's own skeleton now appears after the read rather than before
 * it. The read is `cache()`d, so the pages below and their metadata share it.
 */
export default async function TeamLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ accountCode: string; teamSlug: string }>;
}) {
  const { accountCode, teamSlug } = await params;
  const team = await orBusy(getTeamProfile(accountCode, teamSlug));
  // Busy (429) is not missing: the page renders the busy notice from the same
  // cached read.
  if (isBusy(team)) return children;
  if (!team) notFound();
  // `/{accountCode}/team/{teamSlug}/{slug}`: the fourth segment, when there is one.
  const slug = await requestPathSegment(3);
  if (slug !== null && !team.eventTypes.some((e) => e.slug === slug)) notFound();
  return children;
}
