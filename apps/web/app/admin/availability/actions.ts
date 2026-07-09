'use server';

import { revalidatePath } from 'next/cache';
import { adminApi } from '@/lib/admin-api';

export type ActionResult = { ok: boolean; message?: string };

export interface RuleInput {
  days: number[] | null;
  startTime: string;
  endTime: string;
  date: string | null;
}

export async function saveScheduleFullAction(
  scheduleId: string,
  name: string,
  timeZone: string,
  rules: RuleInput[],
): Promise<ActionResult> {
  // Backstop: end > start on every rule (the editor validates overlap client-side).
  for (const r of rules) {
    if (r.endTime <= r.startTime) {
      return { ok: false, message: `A block ends before it starts (${r.startTime}–${r.endTime}).` };
    }
  }
  try {
    await adminApi.updateSchedule(scheduleId, { name: name.trim() || 'Schedule', timeZone, rules });
    revalidatePath('/admin/availability');
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Failed' };
  }
}

export async function createScheduleAction(name: string, timeZone: string): Promise<ActionResult> {
  try {
    await adminApi.createSchedule({ name: name.trim() || 'New schedule', timeZone, rules: [] });
    revalidatePath('/admin/availability');
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Failed' };
  }
}

export async function deleteScheduleAction(id: string): Promise<ActionResult> {
  try {
    await adminApi.deleteSchedule(id);
    revalidatePath('/admin/availability');
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Could not delete schedule.' };
  }
}
