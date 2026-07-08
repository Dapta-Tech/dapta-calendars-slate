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
  timeZone: string,
  rules: RuleInput[],
): Promise<ActionResult> {
  // Validate end > start on every rule.
  for (const r of rules) {
    if (r.endTime <= r.startTime) {
      return { ok: false, message: `A block ends before it starts (${r.startTime}–${r.endTime}).` };
    }
  }
  try {
    await adminApi.updateSchedule(scheduleId, { timeZone, rules });
    revalidatePath('/admin/availability');
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Failed' };
  }
}
