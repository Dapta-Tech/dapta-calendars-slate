'use server';

import { revalidatePath } from 'next/cache';
import { adminApi } from '@/lib/admin-api';

export type ActionResult = { ok: boolean; message?: string };

export async function createConnectionAction(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  try {
    await adminApi.createConnection({
      provider: String(form.get('provider') ?? 'google'),
      externalId: String(form.get('externalId') ?? ''),
      primaryEmail: form.get('primaryEmail') ? String(form.get('primaryEmail')) : undefined,
      checkConflicts: form.get('checkConflicts') === 'on',
      isDestination: form.get('isDestination') === 'on',
    });
    revalidatePath('/admin/connections');
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Failed' };
  }
}

export async function deleteConnectionAction(id: string): Promise<void> {
  await adminApi.deleteConnection(id);
  revalidatePath('/admin/connections');
}
