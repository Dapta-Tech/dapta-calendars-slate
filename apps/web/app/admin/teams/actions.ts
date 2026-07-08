'use server';

import { revalidatePath } from 'next/cache';
import { adminApi } from '@/lib/admin-api';

export type ActionResult = { ok: boolean; message?: string };

export async function createTeamAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  try {
    await adminApi.createTeam({
      name: String(form.get('name') ?? ''),
      slug: String(form.get('slug') ?? ''),
      timeZone: String(form.get('timeZone') ?? 'UTC'),
    });
    revalidatePath('/admin/teams');
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Failed' };
  }
}

export async function deleteTeamAction(id: string): Promise<void> {
  try {
    await adminApi.deleteTeam(id);
  } catch {
    /* orphan guard may block — surfaced via reload */
  }
  revalidatePath('/admin/teams');
}

export async function addMemberAction(teamId: string, memberId: string): Promise<void> {
  await adminApi.addTeamMember(teamId, { memberId });
  revalidatePath('/admin/teams');
}

export async function removeMemberAction(teamId: string, memberId: string): Promise<void> {
  await adminApi.removeTeamMember(teamId, memberId);
  revalidatePath('/admin/teams');
}
