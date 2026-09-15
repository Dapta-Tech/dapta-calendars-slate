import { randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { authProvider } from '@/lib/auth-session';
import { requestOrigin } from '@/lib/request-origin';

const OAUTH_STATE_COOKIE = 'slate_oauth_state';

/**
 * WorkOS login hand-off (AUTH-WEB-CONTRACT §3.1). The web holds NO WorkOS secret;
 * IAM builds the AuthKit login URL. We mint a random `state`, stash it in a
 * short-lived httpOnly cookie, and pass it along — the callback rejects any
 * response whose `state` doesn't match (login-CSRF / session-fixation guard).
 * OSS / local builds have no IAM → bounce to /login (vendor-clean).
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const origin = requestOrigin(req);
  const iam = process.env.IAM_BASE_URL?.replace(/\/$/, '');
  if (authProvider() !== 'workos' || !iam) {
    return NextResponse.redirect(new URL('/login', origin));
  }

  const state = randomBytes(24).toString('base64url');
  (await cookies()).set(OAUTH_STATE_COOKIE, state, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 600, // 10 min — just long enough to finish the round-trip
  });

  // `prompt=login` makes the hosted login show its sign-in screen even when the
  // provider's own session cookie is still alive, which is what turns the button
  // on the signed-out landing into a real "sign in as someone" rather than a
  // silent re-authentication into the account the person just left. It is also
  // what makes skipping the IdP logout hop viable at all: switching accounts
  // stays possible.
  //
  // Allowlisted to the one value we mean — this route is directly reachable and
  // the value ends up on an external authorize URL. The bare auto-redirect from
  // /login sends no prompt, keeping the silent SSO for arrivals from the
  // platform.
  const prompt = new URL(req.url).searchParams.get('prompt') === 'login' ? 'login' : null;

  const returnTo = `${origin}/api/auth/callback`;
  const res = await fetch(
    `${iam}/auth/login-url?returnTo=${encodeURIComponent(returnTo)}&state=${encodeURIComponent(state)}` +
      (prompt ? `&prompt=${prompt}` : ''),
    { cache: 'no-store' },
  ).catch(() => null);
  const loginUrl = res && res.ok ? ((await res.json().catch(() => ({}))) as { loginUrl?: string }).loginUrl : undefined;
  if (!loginUrl) return NextResponse.redirect(new URL('/login?error=login', origin));

  // Parsed ONCE, before the prompt branch and not inside it: `NextResponse
  // .redirect` throws on a malformed URL, so handing it the IAM's string
  // unchecked turns a bad answer from the identity service into an unhandled
  // 500 on the login path. The error card is the right landing either way.
  let target: URL;
  try {
    target = new URL(loginUrl);
  } catch {
    return NextResponse.redirect(new URL('/login?error=login', origin));
  }
  // The IAM does not forward `prompt` onto the authorize URL yet, so patch it on
  // ourselves. Forwarded above as well, so nothing changes here the day it does.
  if (prompt) target.searchParams.set('prompt', prompt);
  return NextResponse.redirect(target.toString());
}
