import 'server-only';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { SESSION_COOKIE } from './session';

// SERVER-side API base. MUST read the runtime env var `API_URL` — NOT
// `NEXT_PUBLIC_API_URL`, which Next INLINES at BUILD time (baked into the image,
// so a single image can't point at the right env). Falls back to NEXT_PUBLIC_*
// then localhost for a bare clone. Set `API_URL` in each deployment's config.
const API_URL = process.env.API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

/**
 * Web session lifecycle (per AUTH-WEB-CONTRACT §1–4). The web owns the session;
 * the API owns identity resolution. Two shapes, one per provider:
 *  - local  → carries the dev-login email (sent as `x-slate-email`).
 *  - workos → carries the IAM-minted platform JWT (sent as `Authorization: Bearer`).
 * Stored ONLY in an httpOnly cookie — never exposed to client JS.
 */
export type Session =
  | { provider: 'local'; email: string }
  | { provider: 'workos'; accessToken: string; refreshToken?: string; sessionId?: string };

/** The workos branch alone — what a refresh can ever produce. */
export type WorkosSession = Extract<Session, { provider: 'workos' }>;

export const authProvider = (): 'local' | 'workos' =>
  process.env.AUTH_PROVIDER === 'workos' ? 'workos' : 'local';

const secret = () => process.env.WEB_SESSION_SECRET ?? '';

/** How long the web waits on the identity service before giving up. Both upstream
 *  calls are best-effort side quests on a path the user is already committed to,
 *  so neither may hang a logout or a page render. */
const IAM_TIMEOUT_MS = 5000;

/**
 * Default-deny: an UNSIGNED session cookie is a forgeable `x-slate-email`/JWT
 * carrier, so we only permit it for the zero-risk `local` dev provider. Any
 * non-local deployment MUST set WEB_SESSION_SECRET — otherwise we fail loud
 * rather than silently accept forgeable sessions.
 */
function requireSecretUnlessLocal(): void {
  if (!secret() && authProvider() !== 'local') {
    throw new Error(
      'WEB_SESSION_SECRET is required unless AUTH_PROVIDER=local — refusing to issue an unsigned, forgeable session cookie.',
    );
  }
}

/** `base64url(payload).hmac` — tamper-evident when WEB_SESSION_SECRET is set; a
 *  bare OSS `local` fork with no secret uses the payload alone (dev only). */
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
    // Validate the required field per branch — a corrupt/stale-format cookie must
    // read as "no session" (→ clean 401 → login), not a half-authenticated state.
    if (s?.provider === 'local' && typeof s.email === 'string' && s.email) return s;
    if (s?.provider === 'workos' && typeof s.accessToken === 'string' && s.accessToken) return s;
    return null;
  } catch {
    return null;
  }
}

export async function getSession(): Promise<Session | null> {
  const jar = await cookies();
  return decodeSession(jar.get(SESSION_COOKIE)?.value);
}

/**
 * Best-effort upstream revoke: POST {IAM}/auth/logout with `redirect=false`, so
 * the identity service revokes the upstream session server-side instead of
 * redirecting anyone itself.
 *
 * Deliberately UNAUTHENTICATED: /auth/logout is a public IAM route (like login
 * and refresh), and sending an expired Bearer on it is what creates
 * logout → 401 → logout loops — the failure this whole unit exists to end.
 * Fired even without a session id (a `{}` body): the IAM can still invalidate
 * its own server-side state.
 *
 * Returns nothing, on purpose. The identity service answers with an IdP logout
 * URL and NO caller here follows it: the browser never visits the identity
 * provider, so no path in this app can end the person's whole platform session,
 * and nothing depends on the provider's logout-redirect allowlist. The accepted
 * consequence, identical to the platform app: the provider's own cookie stays
 * alive, so a bare /login still re-authenticates the same person silently —
 * which is exactly why the signed-out landing's button asks for a prompt.
 *
 * Never throws and never hangs past its timeout: local cleanup must not be
 * hostage to the identity service being up. It IS awaited, so a hung service
 * can still cost a sign-out up to five seconds of spinner — deliberate, because
 * detaching the promise would drop the revoke entirely on any host that stops
 * executing once the response is sent, and a revoke that silently does not
 * happen is worse than a slow one.
 */
export async function revokeUpstreamSession(session: Session | null): Promise<void> {
  const iam = process.env.IAM_BASE_URL?.replace(/\/$/, '');
  if (!iam || session?.provider !== 'workos') return;
  const sessionId = session.sessionId;
  // Both spellings, one id: the IAM keys the upstream revoke off
  // `workos_session_id` and its own row off `session_id`.
  const body = sessionId ? { workos_session_id: sessionId, session_id: sessionId } : {};
  await fetch(`${iam}/auth/logout?redirect=false`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
    signal: AbortSignal.timeout(IAM_TIMEOUT_MS),
  }).catch(() => null);
}

/**
 * An access token's claims, decoded WITHOUT verifying the signature.
 *
 * Deliberately unverified: the web holds no JWT secret to verify with, and it
 * does not need one — the API re-verifies the token (HS256) on every request
 * that uses it, so nothing here is a trust decision. A malformed token yields
 * null, never a throw.
 */
function tokenClaims(accessToken: string): Record<string, unknown> | null {
  const payload = accessToken.split('.')[1];
  if (!payload) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The upstream session id, read from the access token's own claims.
 *
 * The callback's `?session=` blob carries `session_id` = the identity service's
 * OWN session-row id (a UUID) and no upstream-session field at all. The only
 * place the real upstream id (`session_…`) exists is a claim inside the JWT the
 * IAM mints. Sending the IAM's UUID to the upstream logout endpoint is a silent
 * no-op — it answers 200 with an empty body for an id it cannot resolve — so a
 * sign-out would revoke nothing at all.
 */
export function workosSessionIdFromJwt(accessToken: string): string | null {
  const id = tokenClaims(accessToken)?.workos_session_id;
  return typeof id === 'string' && id ? id : null;
}

/**
 * Whether an access token has reached (or is about to reach) its `exp`.
 *
 * This is the ONLY ceiling the render-side refresh has. `/api/auth/refresh` is
 * driven by browser redirects and remembers nothing between arrivals, so it
 * cannot count attempts the way `hostFetch` does — the limit has to come from
 * the token. The API answers 401 for more than expiry (a claim it cannot
 * resolve, a secret that does not match), minting another token fixes none of
 * those, and the identity service will happily mint one every time. Asking
 * whether the token was actually expired is what stops that becoming a lap.
 *
 * An unreadable `exp` counts as expired: the API REQUIRES the claim, so such a
 * token is guaranteed to 401, and a refresh is the only thing that could help.
 *
 * The default skew errs toward refreshing — a token with seconds left is
 * already expired as far as the next request is concerned. Pass `0` to ask the
 * strict question ("is this token dead right now").
 */
export function accessTokenExpired(accessToken: string, skewSec = 60): boolean {
  const exp = tokenClaims(accessToken)?.exp;
  if (typeof exp !== 'number') return true;
  return Math.floor(Date.now() / 1000) >= exp - skewSec;
}

/**
 * Trade the refresh token for a fresh access token: POST {IAM}/auth/refresh, a
 * public route like login and logout, so no Bearer.
 *
 * The identity service ROTATES the refresh token on every call, so the returned
 * session must ALWAYS be stored — keeping the old one guarantees the next
 * refresh 401s. The upstream session id is re-read from the new JWT (the IAM
 * re-mints it with the claim intact) with the old id kept as a fallback, so a
 * logout after a refresh can still revoke.
 *
 * Concurrent server actions can race this — there is no single process to
 * single-flight in — and the IAM's rotation grace window is what makes that
 * safe, with both racers ending on valid tokens.
 *
 * Returns null and never throws on anything short of success: a 401 (the
 * refresh token is expired or revoked), a down IAM, a timeout, a local session,
 * or a session that never carried a refresh token. Callers treat null as
 * "sign in again".
 */
export async function refreshUpstreamSession(session: Session | null): Promise<WorkosSession | null> {
  const iam = process.env.IAM_BASE_URL?.replace(/\/$/, '');
  if (!iam || session?.provider !== 'workos' || !session.refreshToken) return null;
  const res = await fetch(`${iam}/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refresh_token: session.refreshToken }),
    cache: 'no-store',
    signal: AbortSignal.timeout(IAM_TIMEOUT_MS),
  }).catch(() => null);
  if (!res?.ok) return null;
  const out = (await res.json().catch(() => null)) as {
    access_token?: unknown;
    refresh_token?: unknown;
  } | null;
  if (typeof out?.access_token !== 'string' || !out.access_token) return null;
  return {
    provider: 'workos',
    accessToken: out.access_token,
    refreshToken:
      typeof out.refresh_token === 'string' && out.refresh_token
        ? out.refresh_token
        : session.refreshToken,
    sessionId: workosSessionIdFromJwt(out.access_token) ?? session.sessionId,
  };
}

/**
 * Identity headers for a raw host `fetch()` that doesn't route through
 * admin-api's `req()` (a few server actions post directly). Same contract as
 * admin-api (§1): Bearer for workos, x-slate-email for local, nothing when
 * logged out (→ the API 401s → the gate redirects).
 */
export async function hostHeaders(): Promise<Record<string, string>> {
  const s = await getSession();
  if (s?.provider === 'workos') return { authorization: `Bearer ${s.accessToken}` };
  if (s?.provider === 'local') return { 'x-slate-email': s.email };
  return {};
}

/**
 * Whether THIS context may write the session cookie: a Server Action or a Route
 * Handler may, a Server Component render may not (`cookies().set()` throws).
 * Probed by re-writing the cookie's CURRENT value, so a caller that can write
 * changes nothing but its expiry, and a caller that cannot finds out cheaply.
 *
 * Asked BEFORE the refresh rather than after it, and that order is the whole
 * point: the identity service rotates the refresh token on every call, so a
 * refresh whose result we cannot store spends the token still sitting in the
 * cookie and leaves the next reader holding a credential already retired.
 *
 * Writing is safe to do speculatively because the cookie store is keyed by
 * NAME: a later `set` or `delete` of the same name replaces this one rather
 * than appending, so the probe cannot leave a live cookie behind on a response
 * that goes on to sign the person out. All it costs is a refreshed expiry.
 */
async function sessionCookieIsWritable(): Promise<boolean> {
  const jar = await cookies();
  const current = jar.get(SESSION_COOKIE)?.value;
  /* Defensive: the only caller arrives after `getSession()` returned a workos
     session, which cannot happen without the cookie. */
  if (current === undefined) return false;
  try {
    jar.set(SESSION_COOKIE, current, sessionCookieOptions());
    return true;
  } catch {
    return false;
  }
}

/**
 * Sign out and land locally: clear the cookie, revoke upstream best-effort,
 * redirect. Never returns.
 *
 * The session must be READ before this is called and passed in, because
 * `clearSession()` is the first thing it does and the revoke needs the id the
 * cookie carried. The IdP logout URL is never followed — see
 * `revokeUpstreamSession` — so this can never end the platform session.
 */
export async function signOutAndRedirect(session: Session | null): Promise<never> {
  try {
    await clearSession();
  } catch {
    /* cookies are immutable during render — the redirect still fires */
  }
  await revokeUpstreamSession(session);
  redirect(authProvider() === 'workos' ? '/login?signedout=1' : '/login');
}

/**
 * The single answer to a `401` on a host call, shared by server actions
 * (`hostFetch`) and the admin API client (`admin-api.ts`). It refreshes the
 * session in place and returns, and the caller then retries its request ONCE.
 *
 * It returns ONLY on success. Every other outcome throws a redirect:
 *  - to `/api/auth/refresh` when this context cannot write cookies, so the one
 *    route handler that can does the exchange instead;
 *  - to `/login` when there is nothing to refresh or the refresh token is dead.
 *
 * Both callers get the same contract because both serve both contexts: an
 * action reaching `admin-api.ts` refreshes inline, exactly as `hostFetch` does,
 * rather than being soft-navigated into a route handler that would strand the
 * URL bar on `/api/auth/refresh` and rotate the token again on a reload.
 */
export async function refreshOrSignOut(): Promise<void> {
  const session = await getSession();
  if (session?.provider === 'workos') {
    if (!(await sessionCookieIsWritable())) redirect('/api/auth/refresh');
    const refreshed = await refreshUpstreamSession(session);
    if (refreshed) {
      await setSession(refreshed);
      return;
    }
  }
  await signOutAndRedirect(session);
}

/**
 * Authenticated host fetch for SERVER ACTIONS (AUTH-WEB-CONTRACT §1 + §4):
 * attaches identity, and on a `401` first tries to refresh the session IN PLACE
 * before treating it as a logout — an expiring token is the ordinary end of a
 * token's life, not a reason to sign anyone out. Only when the refresh fails,
 * or the retried request 401s again, does it clear + revoke and bounce to
 * /login. The thrown redirect must be re-thrown past any action catch (use
 * `unstable_rethrow(e)` first in the catch). Intended for an action or a route
 * handler — it may write the cookie.
 */
export async function hostFetch(path: string, init?: RequestInit): Promise<Response> {
  const call = async (): Promise<Response> =>
    fetch(`${API_URL}${path}`, {
      ...init,
      headers: { ...((init?.headers as Record<string, string>) ?? {}), ...(await hostHeaders()) },
      cache: 'no-store',
    });

  let res = await call();

  if (res.status === 401) {
    // One refresh, one retry, never a loop.
    await refreshOrSignOut();
    res = await call();
  }

  if (res.status === 401) {
    // The token the identity service has just minted is being rejected, so the
    // 401 was never about expiry and refreshing again cannot fix it. Inline
    // rather than a redirect into /api/auth/logout, because an action
    // `redirect()` into a route handler soft-navigates and strands the URL bar
    // there.
    await signOutAndRedirect(await getSession());
  }

  return res;
}

/** Cookie attributes, read at call time so a test (or a boot) can change NODE_ENV. */
const sessionCookieOptions = () =>
  ({
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 60 * 60 * 24 * 30, // 30d, matching the workos refresh-token TTL
  }) as const;

/** Set the session cookie (only valid in a Server Action or Route Handler). */
export async function setSession(s: Session): Promise<void> {
  requireSecretUnlessLocal();
  const jar = await cookies();
  jar.set(SESSION_COOKIE, encodeSession(s), sessionCookieOptions());
}

/** Clear the session cookie (only valid in a Server Action or Route Handler). */
export async function clearSession(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}
