import type { Metadata } from 'next';
import {
  DEFAULT_ACCENT,
  getMessages,
  type BookingButtons,
  type BookingCorners,
  type Locale,
} from '@slate/shared';
import type { PublicProfile } from '@slate/types';
import type { TeamProfile } from '@/lib/api';
import { resolveAvatarUrl } from '@/lib/avatar';
import { bookingCanvasOf } from '@/lib/booking-canvas';
import { logoOf, teamBranding } from '@/lib/brand-kit';
import { brandingShown } from '@/lib/growth';
import { OG_SIZE, type BookingCardInput } from '@/lib/og-card';
import { cardImageDataUri } from '@/lib/og-image-source';
import { IS_DAPTA_BRAND, PRODUCT_NAME } from '@/lib/product-name';

/**
 * A public page's link preview image: `<page>/card.png?lang=<locale>`.
 *
 * A route of its own rather than Next's `opengraph-image` file, because the
 * file's URL cannot carry the language: a page asked in Spanish would point at
 * an image drawn in whatever language the image request happened to state, and
 * the preview's words and picture could disagree. Here the page names the
 * language it chose, so the text and the image of one preview always match.
 *
 * The name has a dot in it so no event's link name is ever likely to be it;
 * the old `opengraph-image` address is rewritten to it (`next.config.mjs`), so
 * a preview shared before the move still draws.
 */
export const CARD_FILE = 'card.png';

export function cardUrl(pagePath: string, locale: Locale): string {
  return `${pagePath}/${CARD_FILE}?lang=${locale}`;
}

/**
 * A public page's Open Graph and X tags: its words, and its card in the same
 * language. `alt` is the card's headline, so a screen reader gets what a
 * sighted reader sees.
 */
export function previewMetadata(p: {
  pagePath: string;
  locale: Locale;
  title: string;
  description: string;
  type: 'website' | 'profile';
  alt: string;
}): Pick<Metadata, 'openGraph' | 'twitter'> {
  const image = {
    url: cardUrl(p.pagePath, p.locale),
    width: OG_SIZE.width,
    height: OG_SIZE.height,
    type: 'image/png',
    alt: p.alt,
  };
  return {
    openGraph: { title: p.title, description: p.description, type: p.type, images: [image] },
    twitter: { card: 'summary_large_image', title: p.title, description: p.description, images: [image] },
  };
}

type Style = Record<string, unknown>;
type Card = BookingCardInput;

/** The look a card shares with the page it previews. */
function look(brandColor: string | null | undefined, style: Style | null | undefined) {
  const s = (style ?? {}) as Style;
  return {
    canvas: bookingCanvasOf(s),
    accent: brandColor ?? DEFAULT_ACCENT,
    buttons: s.buttons as BookingButtons | undefined,
    corners: s.corners as BookingCorners | undefined,
  };
}

/**
 * The product mark is Dapta branding: an account that turned it off while
 * paying gets a card with the host alone (`showDaptaBranding`), and a fork's
 * card never carries it.
 */
function productName(payload: { showBranding?: boolean }): string | null {
  return IS_DAPTA_BRAND && brandingShown(payload) ? PRODUCT_NAME : null;
}

/** A person's profile: photo or monogram, name, bio. */
export async function profileCard(profile: PublicProfile, locale: Locale): Promise<Card> {
  const m = profile.member;
  const name = m.displayName ?? m.handle;
  const style = (m.style ?? {}) as Style;
  return {
    kind: 'profile',
    ...look(m.brandColor, style),
    hostName: name,
    photo: await cardImageDataUri(resolveAvatarUrl(m.avatarUrl, m.connectedAvatarUrl)),
    title: name,
    subtitle: typeof style.bio === 'string' ? style.bio : null,
    cta: getMessages(locale).growth.shareCardCta,
    productName: productName(profile),
  };
}

/** One of a person's events: the host, the event's title, length and description. */
export async function eventCard(
  profile: PublicProfile,
  event: PublicProfile['eventTypes'][number],
  locale: Locale,
): Promise<Card> {
  const m = profile.member;
  return {
    kind: 'event',
    ...look(m.brandColor, m.style as Style | null),
    hostName: m.displayName ?? m.handle,
    photo: await cardImageDataUri(resolveAvatarUrl(m.avatarUrl, m.connectedAvatarUrl)),
    title: event.title,
    subtitle: event.description,
    duration: `${event.lengthMinutes} min`,
    cta: getMessages(locale).growth.shareCardCta,
    productName: productName(profile),
  };
}

/**
 * A team's page, or one of its events. A team wears the workspace's brand kit
 * (`teamBranding`) and shows its logo where a person shows a photo, drawn whole
 * rather than cut to a circle.
 */
export async function teamCard(
  team: TeamProfile,
  locale: Locale,
  event?: TeamProfile['eventTypes'][number],
): Promise<Card> {
  const branding = teamBranding(team.brand);
  const logo = await cardImageDataUri(team.team.logoUrl ?? logoOf(branding.style));
  const base = {
    ...look(branding.brandColor, branding.style),
    hostName: team.team.name,
    photo: logo,
    photoIsLogo: true,
    cta: getMessages(locale).growth.shareCardCta,
    productName: productName(team),
  };
  return event
    ? {
        ...base,
        kind: 'event',
        title: event.title,
        subtitle: event.description,
        duration: `${event.lengthMinutes} min`,
      }
    : { ...base, kind: 'profile', title: team.team.name, subtitle: null };
}
