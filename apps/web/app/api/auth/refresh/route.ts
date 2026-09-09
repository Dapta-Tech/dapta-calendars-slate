import { NextResponse, type NextRequest } from 'next/server';
import {
  accessTokenExpired,
  getSession,
  refreshUpstreamSession,
  setSession,
} from '@/lib/auth-session';
import { requestOrigin } from '@/lib/request-origin';

/**
 * Session refresh for the one context that cannot write cookies itself: a 401
 * during a Server Component render (`admin-api.ts`, where `cookies().set()`
 * throws). The render redirects here; this handler trades the refresh token for
 * a fresh access token, stores it, and sends the person back to /admin. When
 * the refresh fails — the refresh token is expired or revoked, or the identity
 * service is down — it hands off to the logout route, which is exactly where a
 * render-time 401 went before refresh existed.
 *
 * No `next` parameter, on purpose: a redirect target taken from the query is an
 * open-redirect surface on the auth path, and /admin is where the pre-refresh
 * flow already landed. Server actions never come through here — they refresh
 * inline, so the URL bar stays where the person left it.
 *
 * A note on the shape: this is a state-mutating GET with no CSRF token, so a
 * forced top-level navigation can trigger it (the session cookie is
 * `sameSite: 'lax'`). The outcomes are a rotation the victim's own browser
 * receives, or a sign-out — and `/api/auth/logout` has always been reachable
 * the same way and always signs out, so this adds no new class of mischief.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const origin = requestOrigin(req);
  const signOut = NextResponse.redirect(new URL('/api/auth/logout?reason=expired', origin));
  const session = await getSession();

  // ONE refresh per expiry, never a loop — the ceiling `hostFetch` gets from
  // counting attempts, this route has to get from the token itself, because it
  // is driven by browser redirects and remembers nothing between arrivals.
  //
  // The API answers 401 for more than an expired token: a claim it cannot
  // resolve, a secret that does not match. Minting another token fixes none of
  // those and the identity service will happily mint one every time, so without
  // this guard the second arrival looks exactly like the first and /admin → here
  // → /admin runs until the browser gives up, spending a refresh-token rotation
  // per lap. A token still inside its lifetime therefore means the 401 was not
  // an expiry, and signing out is the honest answer.
  if (session?.provider === 'workos' && !accessTokenExpired(session.accessToken)) {
    return signOut;
  }

  const refreshed = await refreshUpstreamSession(session);
  if (!refreshed) return signOut;
  // The SAME predicate as the guard above, and that is what makes termination
  // structural rather than a matter of the identity service's configuration:
  // "we stored it" and "the next arrival will sign out instead of refreshing"
  // become one question. A looser check here would admit a token with less life
  // left than the arrival guard requires — the render would 401, come back, and
  // this route would refresh again, one rotation per lap, forever.
  if (accessTokenExpired(refreshed.accessToken)) return signOut;

  await setSession(refreshed);
  return NextResponse.redirect(new URL('/admin', origin));
}
