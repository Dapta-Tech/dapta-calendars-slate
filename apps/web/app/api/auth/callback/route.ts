import { cookies } from 'next/headers';
import { NextResponse, type NextRequest } from 'next/server';
import { setSession } from '@/lib/auth-session';

const OAUTH_STATE_COOKIE = 'slate_oauth_state';

/**
 * WorkOS callback (AUTH-WEB-CONTRACT §3.2). Verifies the CSRF `state`, then
 * exchanges the one-time `code` for the platform tokens via IAM (a server↔server
 * POST) and stashes them in the httpOnly session cookie — the raw JWT never
 * travels in the query string, referrer, or browser history.
 *
 * ⚠️ CONFIRM(auth §3.2) — the two IAM specifics still unspecified in the contract:
 *   (a) does WorkOS/IAM echo our `state` back on the redirect (assumed: yes, as
 *       `?state=`), and (b) the exact code→token exchange route + DTO (assumed:
 *       POST {IAM}/auth/exchange { code } → { access_token, refresh_token }).
 * Verify against IAM `workos-auth.controller.ts @Get('callback')` +
 * `create-unified-session`; adjust the exchange call below once confirmed.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  const origin = url.origin;
  const iam = process.env.IAM_BASE_URL?.replace(/\/$/, '');
  if (!iam) return NextResponse.redirect(new URL('/login', origin));

  // CSRF: the returned state MUST equal the one we set at login start.
  const jar = await cookies();
  const expected = jar.get(OAUTH_STATE_COOKIE)?.value;
  const got = url.searchParams.get('state');
  jar.delete(OAUTH_STATE_COOKIE);
  if (!expected || !got || expected !== got) {
    return NextResponse.redirect(new URL('/login?error=state', origin));
  }

  const code = url.searchParams.get('code');
  if (!code) return NextResponse.redirect(new URL('/login?error=callback', origin));

  const res = await fetch(`${iam}/auth/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
    cache: 'no-store',
  }).catch(() => null);
  const tokens = res && res.ok ? ((await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string }) : null;
  if (!tokens?.access_token) {
    return NextResponse.redirect(new URL('/login?error=callback', origin));
  }

  await setSession({ provider: 'workos', accessToken: tokens.access_token, refreshToken: tokens.refresh_token });
  return NextResponse.redirect(new URL('/admin', origin));
}
