import { DEFAULT_ACCENT, getMessages } from '@slate/shared';
import { getProfile } from '@/lib/api';
import { publicLocale } from '@/lib/locale';
import { resolveAvatarUrl } from '@/lib/avatar';
import { bookingCanvasOf } from '@/lib/booking-canvas';
import { bookingCardResponse, emptyCardResponse, OG_SIZE } from '@/lib/og-card';
import { cardImageDataUri } from '@/lib/og-image-source';
import { IS_DAPTA_BRAND, PRODUCT_NAME } from '@/lib/product-name';
import { brandingShown } from '@/lib/growth';
import type { BookingButtons, BookingCorners } from '@slate/shared';

/**
 * The host's profile as a link preview: their photo or monogram, their name,
 * their bio, on their own canvas with their own accent (`lib/og-card.tsx`).
 *
 * `alt` is a const on purpose: a `generateImageMetadata` that read the profile
 * would be called while the build collects page data, where no API runs, and
 * would move the card off `/opengraph-image` (the sibling product learned both
 * the hard way). The card carries the name in pixels for everyone who can see it.
 */
export const runtime = 'nodejs';
export const size = OG_SIZE;
export const contentType = 'image/png';
export const alt = 'Booking page';
/** Per host and read at request time; a static render would bake one card. */
export const dynamic = 'force-dynamic';

export default async function ProfileCard({ params }: { params: Promise<{ accountCode: string; handle: string }> }) {
  const { accountCode, handle } = await params;
  const profile = await getProfile(accountCode, handle).catch(() => null);
  if (!profile) return emptyCardResponse();
  const m = profile.member;
  const style = (m.style ?? {}) as Record<string, unknown>;
  const name = m.displayName ?? m.handle;
  const messages = getMessages(await publicLocale());
  return bookingCardResponse({
    kind: 'profile',
    canvas: bookingCanvasOf(style),
    accent: m.brandColor ?? DEFAULT_ACCENT,
    buttons: style.buttons as BookingButtons | undefined,
    corners: style.corners as BookingCorners | undefined,
    hostName: name,
    photo: await cardImageDataUri(resolveAvatarUrl(m.avatarUrl, m.connectedAvatarUrl)),
    title: name,
    subtitle: typeof style.bio === 'string' ? style.bio : null,
    cta: messages.growth.shareCardCta,
    // The product mark is Dapta branding: an account that turned it off
    // while paying gets a card with the host alone (`showDaptaBranding`).
    productName: IS_DAPTA_BRAND && brandingShown(profile) ? PRODUCT_NAME : null,
  });
}
