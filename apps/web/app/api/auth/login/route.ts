import { randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { authProvider } from '@/lib/auth-session';
import { requestOrigin } from '@/lib/request-origin';
import { RETURN_TO_COOKIE, RETURN_TO_PARAM, safeReturnTo, withReturnTo } from '@/lib/return-to';

const OAUTH_STATE_COOKIE = 'slate_oauth_state';
/** As long as the state cookie: the return target lives exactly as long as the login. */
const LOGIN_ROUND_TRIP_SEC = 600;

/**
 * WorkOS login hand-off (AUTH-WEB-CONTRACT §3.1). The web holds NO WorkOS secret;
 * IAM builds the AuthKit login URL. We mint a random `state`, stash it in a
 * short-lived httpOnly cookie, and pass it along — the callback rejects any
 * response whose `state` doesn't match (login-CSRF / session-fixation guard).
 * OSS / local builds have no IAM → bounce to /login (vendor-clean).
 *
 * `?next=` is the dashboard page the sign-in returns to (a booking opened from
 * an email). The identity service returns to one fixed callback URL, so the
 * target does not ride on it: it waits in its own short-lived httpOnly cookie,
 * and the callback reads it back through the same `safeReturnTo` check. A login
 * started without one clears any target an abandoned login left behind.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const origin = requestOrigin(req);
  const next = safeReturnTo(new URL(req.url).searchParams.get(RETURN_TO_PARAM));
  const iam = process.env.IAM_BASE_URL?.replace(/\/$/, '');
  if (authProvider() !== 'workos' || !iam) {
    return NextResponse.redirect(new URL(withReturnTo('/login', next), origin));
  }

  const state = randomBytes(24).toString('base64url');
  const jar = await cookies();
  const short = {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: LOGIN_ROUND_TRIP_SEC, // 10 min, just long enough to finish the round-trip
  } as const;
  jar.set(OAUTH_STATE_COOKIE, state, short);
  if (next) jar.set(RETURN_TO_COOKIE, next, short);
  else jar.delete(RETURN_TO_COOKIE);

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
  // The error card keeps the target, so its retry button returns to the page too.
  const failed = () => NextResponse.redirect(new URL(withReturnTo('/login?error=login', next), origin));
  if (!loginUrl) return failed();

  // Parsed ONCE, before the prompt branch and not inside it: `NextResponse
  // .redirect` throws on a malformed URL, so handing it the IAM's string
  // unchecked turns a bad answer from the identity service into an unhandled
  // 500 on the login path. The error card is the right landing either way.
  let target: URL;
  try {
    target = new URL(loginUrl);
  } catch {
    return failed();
  }
  // The IAM does not forward `prompt` onto the authorize URL yet, so patch it on
  // ourselves. Forwarded above as well, so nothing changes here the day it does.
  if (prompt) target.searchParams.set('prompt', prompt);
  return NextResponse.redirect(target.toString());
}
