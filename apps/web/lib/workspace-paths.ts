/**
 * The paths of the invitation flow, in one place (pure, so a spec and a route
 * handler read them alike).
 *
 * The email links to `/admin/join/{code}`: a dashboard path, so it can be a
 * sign-in's return target, and no new top-level path that an account's own
 * code or vanity name could ever collide with. What the person reads (the
 * Join button, or "not for this account") is `/auth/join`, a product page
 * outside the dashboard's onboarding gate.
 */

/** An account code as it may appear in a path: what the codes and vanity names are made of. */
const CODE = /^[a-z0-9-]{1,64}$/;

/** The code from a path segment or query value, lowercased, or null when it cannot be one. */
export function accountCodeFrom(raw: string): string | null {
  const code = String(raw ?? '').trim().toLowerCase();
  return CODE.test(code) ? code : null;
}

/** Where the invitation email points, and where a signed-out person returns after the login. */
export function adminJoinPath(code: string): string {
  const safe = accountCodeFrom(code);
  return safe ? `/admin/join/${safe}` : '/admin';
}

/** The page that asks the person to join (or tells them the invitation is not theirs). */
export function joinPagePath(code: string): string {
  const safe = accountCodeFrom(code);
  return safe ? `/auth/join?code=${safe}` : '/admin';
}
