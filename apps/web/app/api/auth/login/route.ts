import { NextResponse, type NextRequest } from 'next/server';
import { authProvider } from '@/lib/auth-session';

/**
 * WorkOS login hand-off (AUTH-WEB-CONTRACT §3.1). The web holds NO WorkOS secret;
 * IAM (the IAM service) builds the AuthKit login URL. OSS / local builds have no
 * IAM configured → nothing to hand off to, so we bounce back to /login (keeps the
 * public build vendor-clean).
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const origin = new URL(req.url).origin;
  const iam = process.env.IAM_BASE_URL?.replace(/\/$/, '');
  if (authProvider() !== 'workos' || !iam) {
    return NextResponse.redirect(new URL('/login', origin));
  }
  const returnTo = `${origin}/api/auth/callback`;
  const res = await fetch(`${iam}/auth/login-url?returnTo=${encodeURIComponent(returnTo)}`, {
    cache: 'no-store',
  }).catch(() => null);
  const loginUrl = res && res.ok ? ((await res.json().catch(() => ({}))) as { loginUrl?: string }).loginUrl : undefined;
  if (!loginUrl) return NextResponse.redirect(new URL('/login?error=login', origin));
  return NextResponse.redirect(loginUrl);
}
