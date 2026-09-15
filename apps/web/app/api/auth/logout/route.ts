import { NextResponse, type NextRequest } from 'next/server';
import { clearSession, getSession, revokeUpstreamSession } from '@/lib/auth-session';
import { requestOrigin } from '@/lib/request-origin';

/**
 * Logout: revoke upstream best-effort (see `revokeUpstreamSession`), ALWAYS
 * clear our cookie, land on /login?signedout=1 — whose param suppresses the
 * login page's auto-redirect, or logout would bounce straight back into /admin.
 *
 * The browser NEVER visits the identity provider. Following the IdP logout URL
 * is what used to end the person's whole platform session and strand them on a
 * blank provider page every time a token expired, and it is also what made this
 * route depend on the provider's logout-redirect allowlist. Nothing here does
 * any more. The accepted consequence, same as the platform app: the provider's
 * own cookie stays alive and a bare /login re-authenticates the same person
 * without prompting — which is why the signed-out landing's button sends
 * `prompt=login`.
 *
 * The order matters: the session is READ before `clearSession()`, or the revoke
 * has no id to send.
 *
 * `?reason=expired` marks the session-expiry arrival from `admin-api.ts` and
 * changes nothing here; it stays for observability.
 *
 * The sign-out button does NOT come through here: `signOutAction` and
 * `hostFetch` revoke + clear inline, because an action `redirect()` into a
 * route handler soft-navigates and strands the URL bar on /api/auth/logout.
 * This route serves the contexts that cannot touch the cookie themselves — a
 * 401 inside a Server Component render, and direct navigation.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const origin = requestOrigin(req);
  const session = await getSession();
  await clearSession();
  await revokeUpstreamSession(session);
  return NextResponse.redirect(new URL('/login?signedout=1', origin));
}
