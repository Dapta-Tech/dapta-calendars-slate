'use server';

import { revalidatePath } from 'next/cache';
import { unstable_rethrow } from 'next/navigation';
import type { BrandKit } from '@slate/types';
import { adminApi } from '@/lib/admin-api';

/** Save the workspace brand kit. The API enforces admin/owner. */
export async function saveBrandKitAction(kit: BrandKit): Promise<{ ok: boolean; updatedAt?: number }> {
  try {
    const r = await adminApi.putBrandKit(kit);
    revalidatePath('/admin/settings/booking-page/brand-kit');
    revalidatePath('/admin/settings/booking-page');
    return { ok: true, updatedAt: r.updatedAt };
  } catch (e) {
    unstable_rethrow(e); // let a 401→/login redirect through
    return { ok: false };
  }
}
