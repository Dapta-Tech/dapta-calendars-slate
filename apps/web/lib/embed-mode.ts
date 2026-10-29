/**
 * What turns embed mode on, and nothing else: dependency-free, so the
 * middleware (which keeps an embed's frame where it is) and `lib/embed.ts`
 * (which renders the page as an embed) read one rule and cannot drift.
 */

/** The query key that turns embed mode on. */
export const EMBED_PARAM = 'embed';

/**
 * `embed=1` turns the mode on; `embed=true` is accepted because a host
 * hand-editing a snippet writes it about as often. Anything else — including
 * `embed=0` and a bare `?embed` — is not embed mode: the failure direction
 * that matters is a page accidentally rendering AS an embed, not one failing to.
 */
export function isEmbedValue(raw: string | null | undefined): boolean {
  const value = raw?.trim().toLowerCase();
  return value === '1' || value === 'true';
}
