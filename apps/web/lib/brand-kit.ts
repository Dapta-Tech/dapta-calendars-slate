import { withBrandKit, type BrandKit } from '@slate/types';

/**
 * The logo a page draws, read from its stored style. A host's page carries it
 * only after "Apply kit" snapshotted it there; anything that is not a non-empty
 * string draws nothing, so an old or hand-edited row cannot break the page.
 */
export function logoOf(style: Record<string, unknown> | null | undefined): string | null {
  const v = style?.logoUrl;
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

/**
 * A team page's branding: the workspace kit over nothing, since a team stores
 * no branding of its own. With no kit this is `{ brandColor: null, style: null }`,
 * exactly what the team pages passed before there was a kit.
 */
export function teamBranding(kit: BrandKit | null | undefined) {
  return withBrandKit({ brandColor: null, style: null }, kit);
}
