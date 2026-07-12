import { NextResponse, type NextRequest } from 'next/server';
import { clearSession } from '@/lib/auth-session';
import { requestOrigin } from '@/lib/request-origin';

/**
 * Logout — v1: clear our httpOnly session cookie and return to /login.
 *
 * The private deployment adapter has no GET /auth/logout (the previously
 * assumed shape returned 404). Its contract is POST /auth/logout with
 * the WorkOS session id → { logoutUrl } — a full single-logout needs us to
 * persist `session_id` from the callback payload and POST it here (follow-up;
 * until then the WorkOS session may silently re-auth on the next login, which
 * matches the platform's current behavior).
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const origin = requestOrigin(req);
  await clearSession();
  return NextResponse.redirect(new URL('/login', origin));
}
