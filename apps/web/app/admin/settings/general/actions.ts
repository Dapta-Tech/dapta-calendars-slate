'use server';

import { revalidatePath } from 'next/cache';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export type ActionResult = { ok: boolean; message?: string };

export async function saveGeneralAction(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  try {
    const displayName = String(form.get('displayName') ?? '');
    const timeZone = String(form.get('timeZone') ?? 'UTC');
    const handle = String(form.get('handle') ?? '').trim();

    // Rename handle first (if changed + present); only then save the rest.
    if (handle) {
      const r = await fetch(`${API}/v1/me/handle`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ handle }),
        cache: 'no-store',
      });
      if (!r.ok && r.status !== 409) {
        return { ok: false, message: 'Failed to update handle.' };
      }
      if (r.status === 409) {
        const j = (await r.json().catch(() => ({}))) as { message?: string };
        return { ok: false, message: `Handle unavailable (${j.message ?? 'taken'}).` };
      }
    }

    const res = await fetch(`${API}/v1/me/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName, timeZone }),
      cache: 'no-store',
    });
    if (!res.ok) return { ok: false, message: 'Failed to save settings.' };
    revalidatePath('/admin/settings/general');
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Failed' };
  }
}
