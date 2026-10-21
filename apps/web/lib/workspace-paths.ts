/**
 * The paths of the invitation flow, in one place (pure, so a spec and a route
 * handler read them alike).
 */

/** An account code as it may appear in a path: what the codes and vanity names are made of. */
const CODE = /^[A-Za-z0-9_-]{1,64}$/;

/** The code from a path segment, lowercased, or null when it cannot be one. */
export function accountCodeFrom(raw: string): string | null {
  const code = String(raw ?? '').trim().toLowerCase();
  return CODE.test(code) ? code : null;
}

/** Where joining a workspace happens: a dashboard page, so it can be a sign-in's return target. */
export function adminJoinPath(code: string): string {
  const safe = accountCodeFrom(code);
  return safe ? `/admin/join/${safe}` : '/admin';
}

/** What the signed-in person sees when no invitation to that workspace is theirs. */
export function notForYouPath(code: string): string {
  const safe = accountCodeFrom(code);
  return safe ? `/invite/not-for-you?code=${safe}` : '/invite/not-for-you';
}
