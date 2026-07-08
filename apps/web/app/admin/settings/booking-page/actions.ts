'use server';

import { revalidatePath } from 'next/cache';
import { adminApi } from '@/lib/admin-api';

export type SaveResult = { ok: boolean; message?: string };

export async function saveBrandingAction(payload: {
  displayName?: string | null;
  brandColor?: string | null;
  style?: Record<string, unknown>;
}): Promise<SaveResult> {
  try {
    await adminApi.updateBranding(payload);
    revalidatePath('/admin/settings/booking-page');
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Failed' };
  }
}
