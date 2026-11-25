import type { NextRequest } from 'next/server';
import { getProfile } from '@/lib/api';
import { publicLocale } from '@/lib/locale';
import { bookingCardResponse, emptyCardResponse } from '@/lib/og-card';
import { profileCard } from '@/lib/share-card';

/**
 * A person's profile as a link preview (`lib/share-card.ts`, `lib/og-card.tsx`).
 * The page names the language in `?lang=`; a request without one (an address
 * shared before the move) gets the language the page itself would choose.
 */
export const runtime = 'nodejs';
/** Per host and read at request time; a static render would bake one card. */
export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ accountCode: string; handle: string }> },
) {
  const { accountCode, handle } = await params;
  const profile = await getProfile(accountCode, handle).catch(() => null);
  if (!profile) return emptyCardResponse();
  const lang = req.nextUrl.searchParams.get('lang');
  const locale = await publicLocale(lang ?? undefined, profile.member.locale);
  // Without `lang` the language came from this request's headers: not reusable.
  return bookingCardResponse(await profileCard(profile, locale), { reusable: Boolean(lang) });
}
