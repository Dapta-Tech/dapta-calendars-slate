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
 * An event page as a link preview: the host (photo or monogram, and name), the
 * event's title and length, its description when it has one, and the page's
 * own primary button, on the host's canvas with the host's accent
 * (`lib/og-card.tsx`). See the profile's card for why `alt` is a const.
 */
export const runtime = 'nodejs';
export const size = OG_SIZE;
export const contentType = 'image/png';
export const alt = 'Booking page';
export const dynamic = 'force-dynamic';

export default async function EventCard({
  params,
}: {
  params: Promise<{ accountCode: string; handle: string; slug: string }>;
}) {
  const { accountCode, handle, slug } = await params;
  const profile = await getProfile(accountCode, handle).catch(() => null);
  const event = profile?.eventTypes.find((e) => e.slug === slug);
  if (!profile || !event) return emptyCardResponse();
  const m = profile.member;
  const style = (m.style ?? {}) as Record<string, unknown>;
  const messages = getMessages(await publicLocale());
  return bookingCardResponse({
    kind: 'event',
    canvas: bookingCanvasOf(style),
    accent: m.brandColor ?? DEFAULT_ACCENT,
    buttons: style.buttons as BookingButtons | undefined,
    corners: style.corners as BookingCorners | undefined,
    hostName: m.displayName ?? m.handle,
    photo: await cardImageDataUri(resolveAvatarUrl(m.avatarUrl, m.connectedAvatarUrl)),
    title: event.title,
    subtitle: event.description,
    duration: `${event.lengthMinutes} min`,
    cta: messages.growth.shareCardCta,
    // The product mark is Dapta branding: an account that turned it off
    // while paying gets a card with the host alone (`showDaptaBranding`).
    productName: IS_DAPTA_BRAND && brandingShown(profile) ? PRODUCT_NAME : null,
  });
}
