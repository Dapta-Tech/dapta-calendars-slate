import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { ATTRIBUTION_COOKIE } from '@slate/shared';
import { setSession } from '@/lib/auth-session';
import { requestOrigin } from '@/lib/request-origin';

const OAUTH_STATE_COOKIE = 'slate_oauth_state';

/**
 * WorkOS callback contract verified against the private deployment adapter:
 *
 * WorkOS redirects to IAM's OWN /auth/callback; IAM exchanges the code itself
 * and 302s back to our `returnTo` carrying the whole session base64-encoded in
 * a `?session=` query param: { success, access_token, refresh_token, ... }.
 * There is NO code→token exchange endpoint for us to call, and IAM does not
 * echo our CSRF `state` back (it only round-trips `returnTo` inside its own
 * state). So the binding guard here is presence-of-cookie: the login MUST have
 * started on this browser (the short-lived httpOnly cookie set by /api/auth/
 * login). The token itself is verified server-side (HS256) by the API on every
 * request — a forged/foreign `session` blob buys nothing.
 *
 * The raw JWT never persists in the URL: we immediately 302 to /admin, so the
 * `session` param never lands in browser history for the final page.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  const origin = requestOrigin(req);

  // The login round-trip must have started here (cookie set by /api/auth/login).
  const jar = await cookies();
  const started = jar.get(OAUTH_STATE_COOKIE)?.value;
  jar.delete(OAUTH_STATE_COOKIE);
  if (!started) return NextResponse.redirect(new URL('/login?error=state', origin));

  const encoded = url.searchParams.get('session');
  if (!encoded) return NextResponse.redirect(new URL('/login?error=callback', origin));

  let tokens: { access_token?: string; refresh_token?: string; session_id?: string } | null = null;
  try {
    tokens = JSON.parse(Buffer.from(encoded, 'base64').toString('utf-8')) as {
      access_token?: string;
      refresh_token?: string;
      session_id?: string;
    };
  } catch {
    tokens = null;
  }
  if (!tokens?.access_token) {
    return NextResponse.redirect(new URL('/login?error=callback', origin));
  }

  await setSession({
    provider: 'workos',
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    sessionId: tokens.session_id,
  });

  // O2 — claim the campaign click parked at the front door (#94/#65). This is
  // the one moment it can happen: the session now exists (so the API can
  // resolve an account), the identity round-trip has just created that account
  // if it is new, and a Route Handler is one of the few places a cookie may be
  // deleted. The claim is write-once and refuses accounts older than ten
  // minutes, so a returning owner's click stamps nothing.
  await claimParkedAttribution(tokens.access_token);

  return NextResponse.redirect(new URL('/admin', origin));
}

/**
 * Best-effort by design. A failure here must never cost the user their login:
 * they have a valid session and are one redirect from their dashboard, and a
 * marketing attribution that did not land is worth nothing next to that. The
 * cookie is cleared either way — a blob that could not be claimed now is stale
 * on the next login too, and leaving it would let a much later signup inherit
 * an old campaign.
 *
 * Deliberately a BARE fetch rather than `adminApi`. That client carries a
 * global 401 guard which clears the session and redirects — legal in a route
 * handler, and here it would delete the session cookie `setSession` set a few
 * lines earlier, then have its redirect swallowed by the catch below. The user
 * would reach /admin signed out. A growth push must not be able to do that.
 *
 * Bounded, for the same reason: a hung marketing endpoint must not stall the
 * login redirect.
 */
async function claimParkedAttribution(accessToken: string): Promise<void> {
  const jar = await cookies();
  const raw = jar.get(ATTRIBUTION_COOKIE)?.value;
  if (!raw) return;
  jar.delete(ATTRIBUTION_COOKIE);

  try {
    const attribution = JSON.parse(raw) as Record<string, string>;
    if (!attribution || typeof attribution !== 'object' || Object.keys(attribution).length === 0) {
      return;
    }
    const base =
      process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
    await fetch(`${base}/v1/me/attribution`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ attribution }),
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    /* malformed cookie, timeout, or a refusal — the login proceeds regardless */
  }
}
