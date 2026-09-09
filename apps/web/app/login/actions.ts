'use server';

import { redirect } from 'next/navigation';
import { setSession, getSession, signOutAndRedirect } from '@/lib/auth-session';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Local dev login (AUTH_PROVIDER=local): establish a session that carries the
 * email. `admin-api.ts` sends it as `x-slate-email`; the API's local stub
 * resolves (or JIT-creates) that member's own account. Returns a field error
 * instead of throwing so the form can show it.
 */
export async function signInAction(
  _prev: { error?: string } | null,
  form: FormData,
): Promise<{ error?: string }> {
  const email = String(form.get('email') ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return { error: 'invalid' };
  await setSession({ provider: 'local', email });
  redirect('/admin');
}

/**
 * Logout (AUTH-WEB-CONTRACT §2/§3.5): read the session, clear the cookie, tell
 * the identity service to revoke upstream, land on our own /login. Clearing is
 * what makes logout real in AUTH_LOCAL_STRICT mode (the next /v1/me is a 401 →
 * /login); the revoke is what ends the upstream session under workos.
 *
 * The browser never visits the identity provider, so signing out of this app
 * can never end the person's whole platform session, and nothing here depends
 * on the provider's logout-redirect allowlist. The accepted consequence, same
 * as the platform app: the provider's own cookie stays alive, so the next
 * "sign in" re-authenticates the same person without prompting unless the
 * button asks for a prompt — which the signed-out landing's does.
 *
 * The order matters: the session must be READ before `clearSession()` lands its
 * Set-Cookie, or the revoke has no session id. Local cleanup always runs,
 * whatever the identity service does with the call. Inline rather than a
 * redirect into /api/auth/logout, because an action `redirect()` into a route
 * handler soft-navigates and strands the URL bar there.
 */
export async function signOutAction(): Promise<void> {
  // Read first, then hand the session to the shared sign-out: it clears, revokes
  // and redirects — keyed on the configured provider, not the (already-null)
  // session, because in workos mode a bare /login auto-redirects straight back
  // into the identity service and ?signedout=1 is what suppresses that.
  await signOutAndRedirect(await getSession());
}
