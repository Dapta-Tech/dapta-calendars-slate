import 'server-only';
import { cookies } from 'next/headers';
import { WORKSPACE_HEADER } from '@slate/types';

/**
 * Which workspace (local account id) the dashboard is acting in, when it is
 * not the person's own.
 *
 * The session token says WHO the person is; this cookie only names WHERE, and
 * the API re-checks it against the person's memberships on every call (a name
 * they hold none in is a 403 `WORKSPACE_FORBIDDEN`). No cookie: every call acts
 * in the account the token names, exactly as before workspaces existed.
 *
 * httpOnly, like the session: nothing in the browser needs to read it, and the
 * switcher changes it through a Server Action. In production it carries the
 * `__Host-` prefix, so the browser accepts it only from this host, Secure, on
 * Path=/: a sibling subdomain cannot plant one the API would keep refusing.
 */
export const WORKSPACE_COOKIE = process.env.NODE_ENV === 'production' ? '__Host-slate.workspace' : 'slate.workspace';

/** Where a render whose workspace the API refused is sent: the one context that cannot clear a cookie itself. */
export const WORKSPACE_RESET_PATH = '/api/workspace/reset';

/** The API's error codes for a workspace the person may not act in (yet). */
export const WORKSPACE_REFUSALS: ReadonlySet<string> = new Set(['WORKSPACE_FORBIDDEN', 'INVITATION_PENDING']);

/** Kept until another workspace is chosen or the session ends (`clearSession` drops it). */
const MAX_AGE_SEC = 365 * 24 * 60 * 60;

const cookieOptions = (maxAge: number) =>
  ({
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge,
  }) as const;

/** The chosen workspace's account id, or null when none is chosen. */
export async function chosenWorkspace(): Promise<string | null> {
  return (await cookies()).get(WORKSPACE_COOKIE)?.value?.trim() || null;
}

/** The header naming the chosen workspace, or nothing when none is chosen. */
export async function workspaceHeader(): Promise<Record<string, string>> {
  const id = await chosenWorkspace();
  return id ? { [WORKSPACE_HEADER]: id } : {};
}

/** Remember the workspace. Server Actions and Route Handlers only (a render cannot write cookies; this throws there). */
export async function setWorkspace(accountId: string): Promise<void> {
  (await cookies()).set(WORKSPACE_COOKIE, accountId, cookieOptions(MAX_AGE_SEC));
}

/**
 * Forget it: back to the account the session token names. Expired with the
 * same attributes it was set with, which a `__Host-` cookie requires before a
 * browser lets it go. Throws during a render, like `setWorkspace`.
 */
export async function clearWorkspace(): Promise<void> {
  (await cookies()).set(WORKSPACE_COOKIE, '', cookieOptions(0));
}
