'use server';

import { revalidatePath } from 'next/cache';
import { adminApi } from '@/lib/admin-api';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export type SaveResult = { ok: boolean; message?: string; field?: 'handle' | 'branding' };

export interface StudioPayload {
  handle?: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  coverUrl?: string | null;
  brandColor?: string | null;
  style?: Record<string, unknown>;
}

/**
 * Persist the studio (F20h ordering): rename the handle FIRST — only if that
 * succeeds do we save the branding, so a taken handle never partially saves.
 */
export async function saveStudioAction(payload: StudioPayload): Promise<SaveResult> {
  try {
    if (payload.handle) {
      const res = await fetch(`${API}/v1/me/handle`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ handle: payload.handle }),
        cache: 'no-store',
      });
      if (res.status === 409) {
        const j = (await res.json().catch(() => ({}))) as { message?: string };
        return { ok: false, field: 'handle', message: `Handle unavailable (${j.message ?? 'taken'}).` };
      }
      if (!res.ok) return { ok: false, field: 'handle', message: 'Could not update handle.' };
    }

    await adminApi.updateBranding({
      displayName: payload.displayName,
      avatarUrl: payload.avatarUrl,
      coverUrl: payload.coverUrl,
      brandColor: payload.brandColor,
      style: payload.style,
    });
    revalidatePath('/admin/settings/booking-page');
    return { ok: true };
  } catch (e) {
    return { ok: false, field: 'branding', message: e instanceof Error ? e.message : 'Failed' };
  }
}
