import type { NextRequest } from 'next/server';
import { getProfile } from '@/lib/api';
import { publicLocale } from '@/lib/locale';
import { bookingCardResponse, emptyCardResponse } from '@/lib/og-card';
import { eventCard } from '@/lib/share-card';

/**
 * An event page as a link preview (`lib/share-card.ts`, `lib/og-card.tsx`).
 * The page names the language in `?lang=`; a request without one (an address
 * shared before the move) gets the language the page itself would choose.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ accountCode: string; handle: string; slug: string }> },
) {
  const { accountCode, handle, slug } = await params;
  const profile = await getProfile(accountCode, handle).catch(() => null);
  const event = profile?.eventTypes.find((e) => e.slug === slug);
  if (!profile || !event) return emptyCardResponse();
  const lang = req.nextUrl.searchParams.get('lang');
  const locale = await publicLocale(lang ?? undefined, profile.member.locale);
  // Without `lang` the language came from this request's headers: not reusable.
  return bookingCardResponse(await eventCard(profile, event, locale), { reusable: Boolean(lang) });
}
