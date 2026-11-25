import type { NextRequest } from 'next/server';
import { getTeamProfile } from '@/lib/api';
import { publicLocale } from '@/lib/locale';
import { bookingCardResponse, emptyCardResponse } from '@/lib/og-card';
import { teamCard } from '@/lib/share-card';

/** A team's page as a link preview (`lib/share-card.ts`, `lib/og-card.tsx`). */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ accountCode: string; teamSlug: string }> },
) {
  const { accountCode, teamSlug } = await params;
  const team = await getTeamProfile(accountCode, teamSlug).catch(() => null);
  if (!team) return emptyCardResponse();
  const lang = req.nextUrl.searchParams.get('lang');
  const locale = await publicLocale(lang ?? undefined, team.team.locale);
  // Without `lang` the language came from this request's headers: not reusable.
  return bookingCardResponse(await teamCard(team, locale), { reusable: Boolean(lang) });
}
