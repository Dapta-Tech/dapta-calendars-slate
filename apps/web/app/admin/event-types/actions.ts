'use server';

import { revalidatePath } from 'next/cache';
import { adminApi } from '@/lib/admin-api';

export type ActionResult = { ok: boolean; message?: string };

function num(v: FormDataEntryValue | null, d: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

export async function createEventTypeAction(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  try {
    await adminApi.createEventType({
      title: String(form.get('title') ?? ''),
      slug: String(form.get('slug') ?? ''),
      description: form.get('description') ? String(form.get('description')) : null,
      lengthMinutes: num(form.get('lengthMinutes'), 30),
      minimumBookingNotice: num(form.get('minimumBookingNotice'), 120),
      slotInterval: form.get('slotInterval') ? num(form.get('slotInterval'), 30) : null,
      requiresConfirmation: form.get('requiresConfirmation') === 'on',
      hidden: form.get('hidden') === 'on',
    });
    revalidatePath('/admin/event-types');
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Failed' };
  }
}

export async function updateEventTypeAction(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  try {
    const id = String(form.get('id') ?? '');
    await adminApi.updateEventType(id, {
      title: String(form.get('title') ?? ''),
      slug: String(form.get('slug') ?? ''),
      description: form.get('description') ? String(form.get('description')) : null,
      lengthMinutes: num(form.get('lengthMinutes'), 30),
      minimumBookingNotice: num(form.get('minimumBookingNotice'), 120),
      slotInterval: form.get('slotInterval') ? num(form.get('slotInterval'), 30) : null,
      requiresConfirmation: form.get('requiresConfirmation') === 'on',
      hidden: form.get('hidden') === 'on',
    });
    revalidatePath('/admin/event-types');
    revalidatePath(`/admin/event-types/${id}`);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Failed' };
  }
}

export async function deleteEventTypeAction(id: string): Promise<void> {
  await adminApi.deleteEventType(id);
  revalidatePath('/admin/event-types');
}
