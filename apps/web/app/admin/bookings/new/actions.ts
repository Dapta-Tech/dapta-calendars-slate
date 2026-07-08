'use server';

import { revalidatePath } from 'next/cache';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export interface HostBookingResult {
  ok: boolean;
  uid?: string;
  message?: string;
}

/**
 * R29 host on-behalf booking. Posts to the host surface (singular `attendee`
 * shape — the deliberate path-split from the machine `attendees[]` surface).
 */
export async function createHostBookingAction(payload: {
  handle: string;
  slug: string;
  startUtc: string;
  attendee: { name: string; email: string; timeZone: string; notes?: string };
  answers?: Record<string, string>;
}): Promise<HostBookingResult> {
  try {
    const res = await fetch(`${API}/v1/host/bookings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      cache: 'no-store',
    });
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status === 201) {
      revalidatePath('/admin/bookings');
      return { ok: true, uid: j.uid as string };
    }
    return { ok: false, message: (j.message as string) ?? 'Could not create the booking.' };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Failed' };
  }
}
