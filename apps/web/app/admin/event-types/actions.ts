'use server';

import { unstable_rethrow } from 'next/navigation';

import { revalidatePath } from 'next/cache';
import type { EventLocationDto } from '@slate/types';
import { adminApi } from '@/lib/admin-api';

export type ActionResult = { ok: boolean; message?: string };

export interface EventTypePayload {
  id?: string;
  title: string;
  slug: string;
  description: string | null;
  lengthMinutes: number;
  /** The location kind + its detail; null clears the Where. */
  location: EventLocationDto | null;
  minimumBookingNotice: number;
  slotInterval: number | null;
  beforeEventBuffer: number;
  afterEventBuffer: number;
  seatsPerTimeSlot: number | null;
  requiresConfirmation: boolean;
  hidden: boolean;
  scheduleId: string | null;
  bookingFields: Array<{ name: string; label: string; type: string; required: boolean; defaultCountry?: string }>;
  /** Team events: scheduling method + per-host round-robin detail. */
  schedulingType?: string | null;
  hosts?: Array<{ memberId: string; priority: number | null; weight: number | null; isFixed: boolean }>;
  /** Team events: set on CREATE only (QA2 fix 5). */
  teamId?: string;
  /** PHASE 2 — per-event calendar selection (personal events only). */
  conflictCalendarIds?: string[];
  destinationCalendarId?: string | null;
}

export async function saveEventTypeAction(p: EventTypePayload): Promise<ActionResult> {
  try {
    if (p.id) {
      await adminApi.updateEventType(p.id, p);
    } else {
      await adminApi.createEventType(p);
    }
    revalidatePath('/admin/event-types');
    if (p.id) revalidatePath(`/admin/event-types/${p.id}`);
    return { ok: true };
  } catch (e) {
    unstable_rethrow(e); // let a 401→/login redirect through
    return { ok: false, message: e instanceof Error ? e.message : 'Failed' };
  }
}

/** Quick visibility toggle from the list rows (QA3 fix 4c) — flips only
 *  `hidden` and refreshes every surface that renders the row. */
export async function toggleEventTypeHiddenAction(id: string, hidden: boolean): Promise<ActionResult> {
  try {
    await adminApi.updateEventType(id, { hidden });
    revalidatePath('/admin/event-types');
    revalidatePath('/admin/teams');
    revalidatePath('/admin/teams/[id]', 'page');
    return { ok: true };
  } catch (e) {
    unstable_rethrow(e); // let a 401→/login redirect through
    return { ok: false, message: e instanceof Error ? e.message : 'Failed' };
  }
}

export async function deleteEventTypeAction(id: string): Promise<ActionResult> {
  try {
    await adminApi.deleteEventType(id);
    revalidatePath('/admin/event-types');
    return { ok: true };
  } catch (e) {
    unstable_rethrow(e); // let a 401→/login redirect through
    return { ok: false, message: e instanceof Error ? e.message : 'Could not delete the event.' };
  }
}
