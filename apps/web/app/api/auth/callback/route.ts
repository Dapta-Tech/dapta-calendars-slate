import { NextResponse, type NextRequest } from 'next/server';
import { setSession } from '@/lib/auth-session';

/**
 * WorkOS callback (AUTH-WEB-CONTRACT §3.2). IAM completes the WorkOS handshake,
 * mints the platform tokens, and returns here. We stash them in the httpOnly
 * session cookie and land in /admin. The JWT is never exposed to client JS.
 *
 * ⚠️ CONFIRM(auth §3.2): the EXACT token-delivery from IAM's `/auth/callback` is
 * the single unspecified integration point — query param (implemented here) vs
 * Set-Cookie vs a follow-up `POST /auth/verify-code`/session-exchange. Verify
 * against the IAM service (`workos-auth.controller.ts @Get('callback')` +
 * `create-unified-session` and adjust the token read below if needed.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  const accessToken = url.searchParams.get('access_token') ?? url.searchParams.get('accessToken');
  const refreshToken =
    url.searchParams.get('refresh_token') ?? url.searchParams.get('refreshToken') ?? undefined;
  if (!accessToken) {
    return NextResponse.redirect(new URL('/login?error=callback', url.origin));
  }
  await setSession({ provider: 'workos', accessToken, refreshToken });
  return NextResponse.redirect(new URL('/admin', url.origin));
}
