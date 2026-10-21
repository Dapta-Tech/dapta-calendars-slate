'use server';

import { redirect, unstable_rethrow } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { adminApi } from '@/lib/admin-api';
import { clearWorkspace, setWorkspace } from '@/lib/workspace';

/**
 * The Join button on the invitation page: accept the invitation (the API
 * checks it is this person's, and answers 404 otherwise), then open the
 * workspace. A Server Action, so it is a POST that Next's Origin check guards:
 * nobody can join a workspace on someone's behalf by sending them a link.
 */
export async function acceptInviteAction(_prev: { error?: boolean } | null, form: FormData): Promise<{ error?: boolean }> {
  const accountId = String(form.get('accountId') ?? '');
  if (!accountId) return { error: true };
  let home = false;
  try {
    home = (await adminApi.acceptWorkspace(accountId)).home;
  } catch (e) {
    unstable_rethrow(e); // a 401 sends the person through the login and back
    return { error: true };
  }
  if (home) await clearWorkspace();
  else await setWorkspace(accountId);
  revalidatePath('/admin', 'layout');
  redirect('/admin');
}
