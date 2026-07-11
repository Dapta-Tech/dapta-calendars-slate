import 'server-only';
import { cookies } from 'next/headers';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { SESSION_COOKIE } from './session';

/**
 * Web session lifecycle (per AUTH-WEB-CONTRACT §1–4). The web owns the session;
 * the API owns identity resolution. Two shapes, one per provider:
 *  - local  → carries the dev-login email (sent as `x-slate-email`).
 *  - workos → carries the IAM-minted platform JWT (sent as `Authorization: Bearer`).
 * Stored ONLY in an httpOnly cookie — never exposed to client JS.
 */
export type Session =
  | { provider: 'local'; email: string }
  | { provider: 'workos'; accessToken: string; refreshToken?: string };

export const authProvider = (): 'local' | 'workos' =>
  process.env.AUTH_PROVIDER === 'workos' ? 'workos' : 'local';

const secret = () => process.env.WEB_SESSION_SECRET ?? '';

/** `base64url(payload).hmac` — tamper-evident when WEB_SESSION_SECRET is set; a
 *  bare OSS fork with no secret uses the payload alone (dev convenience only). */
export function encodeSession(s: Session): string {
  const payload = Buffer.from(JSON.stringify(s)).toString('base64url');
  if (!secret()) return payload;
  const sig = createHmac('sha256', secret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function decodeSession(raw: string | undefined): Session | null {
  if (!raw) return null;
  const [payload, sig] = raw.split('.');
  if (!payload) return null;
  if (secret()) {
    const expected = createHmac('sha256', secret()).update(payload).digest('base64url');
    if (!sig || sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      return null; // forged / secret-rotated → treat as no session
    }
  }
  try {
    const s = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Session;
    return s && (s.provider === 'local' || s.provider === 'workos') ? s : null;
  } catch {
    return null;
  }
}

export async function getSession(): Promise<Session | null> {
  const jar = await cookies();
  return decodeSession(jar.get(SESSION_COOKIE)?.value);
}

/** Set the session cookie (only valid in a Server Action or Route Handler). */
export async function setSession(s: Session): Promise<void> {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, encodeSession(s), {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 60 * 60 * 24 * 30, // 30d, matching the workos refresh-token TTL
  });
}

/** Clear the session cookie (only valid in a Server Action or Route Handler). */
export async function clearSession(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}
