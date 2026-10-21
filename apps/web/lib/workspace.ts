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
 * switcher changes it through a Server Action.
 */
export const WORKSPACE_COOKIE = 'slate.workspace';

/** Where a call that the API refused for the workspace is sent: clears the cookie, lands on /admin. */
export const WORKSPACE_RESET_PATH = '/api/workspace/reset';

/** The API's error code for a workspace the person may not act in. */
export const WORKSPACE_FORBIDDEN = 'WORKSPACE_FORBIDDEN';

/** Kept until another workspace is chosen or the session ends (`clearSession` drops it). */
const MAX_AGE_SEC = 365 * 24 * 60 * 60;

/** The chosen workspace's account id, or null when none is chosen. */
export async function chosenWorkspace(): Promise<string | null> {
  return (await cookies()).get(WORKSPACE_COOKIE)?.value?.trim() || null;
}

/** The header naming the chosen workspace, or nothing when none is chosen. */
export async function workspaceHeader(): Promise<Record<string, string>> {
  const id = await chosenWorkspace();
  return id ? { [WORKSPACE_HEADER]: id } : {};
}

/** Remember the workspace. Server Actions and Route Handlers only (a render cannot write cookies). */
export async function setWorkspace(accountId: string): Promise<void> {
  (await cookies()).set(WORKSPACE_COOKIE, accountId, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: MAX_AGE_SEC,
  });
}

/** Forget it: back to the account the session token names. */
export async function clearWorkspace(): Promise<void> {
  (await cookies()).delete(WORKSPACE_COOKIE);
}
