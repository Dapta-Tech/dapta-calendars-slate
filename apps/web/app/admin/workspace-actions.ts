'use server';

import { redirect, unstable_rethrow } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import type { WorkspaceView } from '@slate/types';
import { adminApi } from '@/lib/admin-api';
import { clearWorkspace, setWorkspace } from '@/lib/workspace';

/**
 * Open another of the person's workspaces.
 *
 * A Server Action is a public endpoint, so the id is checked against the
 * person's own list before it is remembered. That is a courtesy, not the gate:
 * the API re-derives the membership on every call made in it and refuses one
 * the person does not hold. Opening a pending invitation is what accepts it.
 */
export async function enterWorkspaceAction(accountId: string): Promise<{ error: 'unavailable' } | void> {
  if (!accountId) return { error: 'unavailable' };
  let target: WorkspaceView | undefined;
  try {
    target = (await adminApi.myWorkspaces()).find((w) => w.accountId === accountId);
  } catch (e) {
    unstable_rethrow(e); // a 401 → /login redirect must go through
    return { error: 'unavailable' };
  }
  if (!target) return { error: 'unavailable' };
  // Back to the account the session names: no workspace header at all, which
  // is exactly how the dashboard behaved before workspaces existed.
  if (target.home) await clearWorkspace();
  else await setWorkspace(accountId);
  // Every admin route renders data for the workspace the cookie names.
  revalidatePath('/admin', 'layout');
  redirect('/admin');
}
