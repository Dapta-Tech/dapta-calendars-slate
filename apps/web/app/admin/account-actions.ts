'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { getSession, setSession, workosSessionIdFromJwt } from '@/lib/auth-session';
import { AccountSwitchDenied, mayPickAccount, switchAccount } from '@/lib/iam';

/**
 * Point this session at a different account.
 *
 * The exchange is server-to-server using the token already in the cookie: no
 * token is ever accepted from the caller. That is the whole security argument —
 * the worst a forged submission achieves is moving the submitter between
 * accounts they already hold, and upstream answers 403 when they do not. A
 * design that took a token from the request instead would let a link log
 * someone into a tenant of the sender's choosing, which is the failure this
 * feature exists to avoid.
 *
 * `mayPickAccount` is re-checked here and not trusted from the UI: a Server
 * Action is a public endpoint, so the menu being hidden is not a gate.
 *
 * The upstream login session is not ended by a switch, and logout still needs
 * its id — so the id is taken from the new token and falls back to the one we
 * already had, same resolution order as the login callback.
 */
export async function switchAccountAction(accountId: string): Promise<{ error: string } | void> {
  const session = await getSession();
  if (session?.provider !== 'workos' || !mayPickAccount(session.accessToken)) {
    return { error: 'unavailable' };
  }
  if (!accountId) return { error: 'unavailable' };

  try {
    const tokens = await switchAccount(session.accessToken, accountId);
    await setSession({
      provider: 'workos',
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? session.refreshToken,
      sessionId: workosSessionIdFromJwt(tokens.accessToken) ?? session.sessionId,
    });
  } catch (e) {
    return { error: e instanceof AccountSwitchDenied ? 'denied' : 'failed' };
  }

  // Every admin route renders data for whichever account the cookie names, so
  // the whole subtree is stale the moment the cookie changes.
  revalidatePath('/admin', 'layout');
  redirect('/admin');
}
