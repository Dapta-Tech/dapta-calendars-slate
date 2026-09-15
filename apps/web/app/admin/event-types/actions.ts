'use server';

import { unstable_rethrow } from 'next/navigation';

import { revalidatePath } from 'next/cache';
import type {
  CrmPropertyCatalog,
  CrmPropertyMappings,
  EventLocationDto,
  EventReminder,
  OneOffLinkView,
} from '@slate/types';
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
  /** Duplicate-booking guard (#69): one upcoming booking per email on this
   *  event. Travels on CREATE and EDIT, personal and team events alike. */
  preventDuplicateBookings: boolean;
  hidden: boolean;
  scheduleId: string | null;
  bookingFields: Array<{ name: string; label: string; type: string; required: boolean; defaultCountry?: string }>;
  /** Reminders + follow-up owned by this event (#68). An empty array is a
   *  deliberate "no reminders", never a reset to the shipped defaults. */
  reminders: EventReminder[];
  /** Team events: scheduling method + per-host round-robin detail. */
  schedulingType?: string | null;
  hosts?: Array<{ memberId: string; priority: number | null; weight: number | null; isFixed: boolean }>;
  /** Team events: set on CREATE only (QA2 fix 5). */
  teamId?: string;
  /** PHASE 2 — per-event calendar selection (personal events only). */
  conflictCalendarIds?: string[];
  destinationCalendarId?: string | null;
  /** H2 (#108) — CRM contact property mappings, provider-keyed. `null` clears
   *  them; omitted leaves whatever the event already had. */
  crmPropertyMappings?: CrmPropertyMappings | null;
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

/**
 * Re-read the CRM contact properties, skipping the five-minute cache (H2 /
 * #108) — the "I just created the property in my CRM" flow, which the
 * never-create rule makes mandatory.
 *
 * A server action rather than a browser fetch: the property list is read with
 * the account's stored credential, and nothing about that ever needs to reach a
 * client. A failure degrades to the same empty-plus-reason shape the API
 * already returns, so the section renders its "could not reach" line instead of
 * throwing away the host's unsaved mappings.
 */
export async function refreshCrmPropertiesAction(): Promise<CrmPropertyCatalog> {
  try {
    return await adminApi.crmContactProperties(true);
  } catch (e) {
    unstable_rethrow(e); // let a 401→/login redirect through
    return { provider: null, connected: false, properties: [], fetchedAt: null, reason: 'unavailable' };
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

// --- One-off invite links (#69 / AB2, #110) --------------------------------
//
// Server actions rather than browser fetches, for the reason every other admin
// call here is one: `adminApi` reads `API_URL` at RUNTIME and attaches the
// session, and neither may reach the client bundle. It matters more than usual
// for this feature, because the payload these actions carry back is the TOKEN
// itself, in clear — the thing a host pastes into a message.

/** One link plus a result, so the panel can render an error without a throw. */
export type OneOffLinkResult =
  | { ok: true; link: OneOffLinkView }
  | { ok: false; message?: string };

export type OneOffLinkListResult =
  | { ok: true; links: OneOffLinkView[] }
  | { ok: false; message?: string };

/**
 * The links on one event, newest first.
 *
 * Answers a RESULT rather than throwing, because the panel that calls it lives
 * inside the event-type form: an unreachable API must cost the host the link
 * list, never the unsaved edits sitting in the rest of that form.
 */
export async function listOneOffLinksAction(eventTypeId: string): Promise<OneOffLinkListResult> {
  try {
    return { ok: true, links: await adminApi.listOneOffLinks(eventTypeId) };
  } catch (e) {
    unstable_rethrow(e); // let a 401→/login redirect through
    return { ok: false, message: e instanceof Error ? e.message : 'Failed' };
  }
}

/**
 * Mint one.
 *
 * Takes no options: a one-off link is a grant over the event in the path and
 * carries no settings of its own. The minted token comes straight back so the
 * host can copy it without a second round trip — and can copy it again later
 * from the list, which is what storing it in clear buys (ADR 0003).
 */
export async function mintOneOffLinkAction(eventTypeId: string): Promise<OneOffLinkResult> {
  try {
    return { ok: true, link: await adminApi.mintOneOffLink(eventTypeId) };
  } catch (e) {
    unstable_rethrow(e); // let a 401→/login redirect through
    return { ok: false, message: e instanceof Error ? e.message : 'Failed' };
  }
}

/**
 * Kill one by hand. ADR 0003 makes revocation a condition of storing the token
 * in clear, not a nicety — a re-readable token a host cannot withdraw is a link
 * they can never take back out of the wrong thread.
 */
export async function revokeOneOffLinkAction(
  eventTypeId: string,
  linkId: string,
): Promise<ActionResult> {
  try {
    await adminApi.revokeOneOffLink(eventTypeId, linkId);
    return { ok: true };
  } catch (e) {
    unstable_rethrow(e); // let a 401→/login redirect through
    return { ok: false, message: e instanceof Error ? e.message : 'Failed' };
  }
}
