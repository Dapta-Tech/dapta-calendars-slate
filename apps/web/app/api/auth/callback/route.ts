import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { ATTRIBUTION_COOKIE } from '@slate/shared';
import { setSession, workosSessionIdFromJwt } from '@/lib/auth-session';
import { requestOrigin } from '@/lib/request-origin';
import { RETURN_TO_COOKIE, safeReturnTo, withReturnTo } from '@/lib/return-to';

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
 *
 * The 302 goes to the dashboard page the login was started for when there is
 * one (the return-target cookie /api/auth/login set, read through
 * `safeReturnTo` again, since a cookie is the browser's to change), else to
 * /admin. The cookie is spent either way, and a failed callback hands the
 * target to the error card so its retry keeps it.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  const origin = requestOrigin(req);

  // The login round-trip must have started here (cookie set by /api/auth/login).
  const jar = await cookies();
  const started = jar.get(OAUTH_STATE_COOKIE)?.value;
  jar.delete(OAUTH_STATE_COOKIE);
  const next = safeReturnTo(jar.get(RETURN_TO_COOKIE)?.value);
  jar.delete(RETURN_TO_COOKIE);
  const failed = (error: string) =>
    NextResponse.redirect(new URL(withReturnTo(`/login?error=${error}`, next), origin));
  if (!started) return failed('state');

  const encoded = url.searchParams.get('session');
  if (!encoded) return failed('callback');

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
  if (!tokens?.access_token) return failed('callback');

  // The blob's `session_id` is the identity service's OWN row id, not the
  // upstream provider's. The only place the upstream id exists is a claim inside
  // the token it just minted, and it is the id a later revoke has to send — the
  // IAM's UUID resolves to nothing upstream, so a sign-out would revoke nothing.
  // The blob's id stays as a fallback, so a token minted without the claim is
  // no worse off than before.
  await setSession({
    provider: 'workos',
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    sessionId: workosSessionIdFromJwt(tokens.access_token) ?? tokens.session_id,
  });

  // O2 — claim the campaign click parked at the front door (#94/#65). This is
  // the one moment it can happen: the session now exists (so the API can
  // resolve an account), the identity round-trip has just created that account
  // if it is new, and a Route Handler is one of the few places a cookie may be
  // deleted. The claim is write-once and refuses accounts older than ten
  // minutes, so a returning owner's click stamps nothing.
  await claimParkedAttribution(tokens.access_token);

  return NextResponse.redirect(new URL(next ?? '/admin', origin));
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
