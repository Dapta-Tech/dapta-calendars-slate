'use server';

import { revalidatePath } from 'next/cache';
import { unstable_rethrow } from 'next/navigation';
import { adminApi, ApiError, type AccountRole, type MemberStatus } from '@/lib/admin-api';

export type ActionResult = { ok: boolean; message?: string };
/** How the invitation email went: queued, not sent by this server, or not queued at all. */
export type InviteEmail = 'queued' | 'off' | 'failed';
/**
 * Invite carries a stable code so the client can localize (email / duplicate /
 * daily limit / generic), and `email`, so the toast never claims a send that
 * did not happen.
 */
export type InviteResult = {
  ok: boolean;
  code?: 'INVALID_EMAIL' | 'EMAIL_TAKEN' | 'LIMIT' | 'FAILED';
  message?: string;
  email?: InviteEmail;
};
/** A resend answers like an invite; `TOO_SOON` inside the per-member or per-workspace window. */
export type ResendResult = { ok: boolean; code?: 'TOO_SOON' | 'FAILED'; message?: string; email?: InviteEmail };

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Invite a member by email with a role (admin or member). Creates an invited
 * row and queues the invitation email, written in `locale` (the inviter's
 * dashboard language).
 */
export async function inviteMemberAction(
  email: string,
  role: 'admin' | 'member',
  locale?: 'en' | 'es',
): Promise<InviteResult> {
  const target = email.trim().toLowerCase();
  if (!target || !EMAIL_RE.test(target)) return { ok: false, code: 'INVALID_EMAIL' };
  try {
    const created = await adminApi.inviteMember({ email: target, role, ...(locale ? { locale } : {}) });
    revalidatePath('/admin/settings/members');
    return { ok: true, email: created.inviteEmail };
  } catch (e) {
    unstable_rethrow(e); // let a 401→/login redirect through
    if (e instanceof ApiError && e.code === 'EMAIL_TAKEN') return { ok: false, code: 'EMAIL_TAKEN' };
    if (e instanceof ApiError && e.code === 'INVITE_LIMIT') return { ok: false, code: 'LIMIT' };
    return { ok: false, code: 'FAILED', message: e instanceof Error ? e.message : undefined };
  }
}

/** Send a pending invitation again. */
export async function resendInviteAction(id: string, locale?: 'en' | 'es'): Promise<ResendResult> {
  try {
    const r = await adminApi.resendInvite(id, locale ? { locale } : {});
    return { ok: true, email: r.inviteEmail };
  } catch (e) {
    unstable_rethrow(e);
    if (e instanceof ApiError && e.code === 'RESEND_TOO_SOON') return { ok: false, code: 'TOO_SOON' };
    return { ok: false, code: 'FAILED', message: e instanceof Error ? e.message : undefined };
  }
}

/** Change a member's account role. The BE guards the last owner + admin-vs-owner. */
export async function setMemberRoleAction(id: string, role: AccountRole): Promise<ActionResult> {
  try {
    await adminApi.updateMember(id, { role });
    revalidatePath('/admin/settings/members');
    return { ok: true };
  } catch (e) {
    unstable_rethrow(e);
    return { ok: false, message: e instanceof Error ? e.message : undefined };
  }
}

/** Enable/disable a member (soft access revocation). */
export async function setMemberStatusAction(id: string, status: MemberStatus): Promise<ActionResult> {
  try {
    await adminApi.updateMember(id, { status });
    revalidatePath('/admin/settings/members');
    return { ok: true };
  } catch (e) {
    unstable_rethrow(e);
    return { ok: false, message: e instanceof Error ? e.message : undefined };
  }
}

/** Hand the workspace to another member — target becomes owner, caller becomes admin. */
export async function transferOwnershipAction(id: string): Promise<ActionResult> {
  try {
    await adminApi.transferOwnership(id);
    revalidatePath('/admin/settings/members');
    return { ok: true };
  } catch (e) {
    unstable_rethrow(e);
    return { ok: false, message: e instanceof Error ? e.message : undefined };
  }
}

/** Remove a member from the workspace (BE guards the last owner). */
export async function removeMemberAction(id: string): Promise<ActionResult> {
  try {
    await adminApi.removeMember(id);
    revalidatePath('/admin/settings/members');
    return { ok: true };
  } catch (e) {
    unstable_rethrow(e);
    return { ok: false, message: e instanceof Error ? e.message : undefined };
  }
}
