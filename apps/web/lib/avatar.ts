/**
 * Which photo a public surface draws, in one place.
 *
 * Two sources, in this order:
 *   1. what the host set in the studio — their explicit choice, and it always
 *      wins, including over a newer photo on the connected account;
 *   2. the photo on the connected calendar account, when the deployment's
 *      calendar backend reports one.
 *
 * Neither is guaranteed. When both are absent the caller draws its initial
 * tile, exactly as it does today — which is also what a bare fork and a
 * deployment whose backend reports no photo will always see.
 *
 * It lives here rather than at each call site because the surfaces have to
 * agree: a studio preview that shows a letter while the live page shows a face
 * is a bug in the preview, not a difference worth having.
 *
 * Both sources are validated, and NOT to the same rule. The host's own value is
 * already validated on the way in (`brandingSchema.avatarUrl` is
 * `z.string().url()`) and the studio's image input accepts an inline `data:`
 * image, so both shapes are legitimate there. The synced value arrives from the
 * deployment's calendar backend and is only ever an address on that provider's
 * CDN: anything else — a `data:` blob of unbounded size, a `javascript:`
 * string, a bare id — is not a photo we should put in a public `<img src>`, and
 * an arbitrary string there renders a broken-image glyph instead of the initial
 * tile the fallback promises. So it must be an http(s) URL or it is no photo.
 */
const HTTP_URL = /^https?:\/\//i;
const INLINE_IMAGE = /^data:image\//i;

export function resolveAvatarUrl(
  explicit: string | null | undefined,
  connected: string | null | undefined,
): string | null {
  const chosen = explicit?.trim();
  if (chosen && (HTTP_URL.test(chosen) || INLINE_IMAGE.test(chosen))) return chosen;
  const synced = connected?.trim();
  return synced && HTTP_URL.test(synced) ? synced : null;
}

/**
 * The photo the host's connected calendar carries, as the studio offers it to
 * remove or restore. The same order the public page uses (`getPublicProfile`):
 * the destination calendar first, the account the host actually schedules
 * from, then any other connection that has one.
 *
 * Read from the host's own connections rather than from the public profile on
 * purpose: once the host removes the photo, the public profile stops carrying
 * it, and the studio still has to show what "Use it again" would bring back.
 */
export function connectedPhotoOf(
  connections: ReadonlyArray<{ isDestination: boolean; avatarUrl?: string | null }>,
): string | null {
  const withPhoto = connections.filter((c) => resolveAvatarUrl(null, c.avatarUrl));
  const pick = withPhoto.find((c) => c.isDestination) ?? withPhoto[0];
  return pick ? resolveAvatarUrl(null, pick.avatarUrl) : null;
}
