import { NextResponse, type NextRequest } from 'next/server';
import { clearSession } from '@/lib/auth-session';
import { requestOrigin } from '@/lib/request-origin';

/**
 * WorkOS logout (AUTH-WEB-CONTRACT §3.5). A cookie-only clear leaves the WorkOS
 * session alive (the next login silently re-auths), so a true logout must also
 * redirect through IAM's logout, which ends the WorkOS session and returns to
 * `return_to`. OSS / local (no IAM) → just /login.
 *
 * ⚠️ CONFIRM(auth §3.5): the exact IAM logout route + return-param name
 * (the IAM `LogoutCommand`/logout usecase). `/auth/logout?return_to=` is the
 * assumed shape.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const origin = requestOrigin(req);
  await clearSession();
  const iam = process.env.IAM_BASE_URL?.replace(/\/$/, '');
  if (!iam) return NextResponse.redirect(new URL('/login', origin));
  const returnTo = `${origin}/login`;
  return NextResponse.redirect(`${iam}/auth/logout?return_to=${encodeURIComponent(returnTo)}`);
}
