'use server';

import { revalidatePath } from 'next/cache';
import { adminApi } from '@/lib/admin-api';

export type ActionResult = { ok: boolean; message?: string };

const DAYS = [0, 1, 2, 3, 4, 5, 6];

export async function saveScheduleAction(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  try {
    const id = String(form.get('scheduleId') ?? '');
    const timeZone = String(form.get('timeZone') ?? 'UTC');
    const rules: Array<{ days: number[]; startTime: string; endTime: string; date: null }> = [];
    for (const d of DAYS) {
      if (form.get(`enabled_${d}`) !== 'on') continue;
      const startTime = String(form.get(`start_${d}`) ?? '09:00');
      const endTime = String(form.get(`end_${d}`) ?? '17:00');
      if (endTime <= startTime) return { ok: false, message: `Day ${d}: end must be after start.` };
      rules.push({ days: [d], startTime, endTime, date: null });
    }
    await adminApi.updateSchedule(id, { timeZone, rules });
    revalidatePath('/admin/availability');
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Failed' };
  }
}
