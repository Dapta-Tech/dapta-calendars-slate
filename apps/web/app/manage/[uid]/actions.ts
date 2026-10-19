'use server';

import { postManage, type ManageResult } from '@/lib/api';

export async function cancelAction(_prev: ManageResult | null, formData: FormData): Promise<ManageResult> {
  const uid = String(formData.get('uid') ?? '');
  const token = String(formData.get('token') ?? '');
  const reason = String(formData.get('reason') ?? '');
  return postManage(uid, token, 'cancel', { reason });
}

export async function rescheduleAction(_prev: ManageResult | null, formData: FormData): Promise<ManageResult> {
  const uid = String(formData.get('uid') ?? '');
  const token = String(formData.get('token') ?? '');
  const newStartUtc = String(formData.get('newStartUtc') ?? '');
  // A code, not a sentence: the page says it in the visitor's language.
  if (!newStartUtc) return { ok: false, error: 'NO_TIME' };
  // Returns the rotated manageUrl so the client can adopt the new token.
  return postManage(uid, token, 'reschedule', { newStartUtc: new Date(newStartUtc).toISOString() });
}
