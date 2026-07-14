'use server';

import { revalidatePath } from 'next/cache';
import { adminApi, type Connection, type ConnectionTestResult } from '@/lib/admin-api';

export type ActionResult = { ok: boolean; message?: string };

export async function createConnectionAction(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  try {
    await adminApi.createConnection({
      provider: String(form.get('provider') ?? 'google'),
      externalId: String(form.get('externalId') ?? ''),
      primaryEmail: form.get('primaryEmail') ? String(form.get('primaryEmail')) : undefined,
      checkConflicts: form.get('checkConflicts') === 'on',
      isDestination: form.get('isDestination') === 'on',
    });
    revalidatePath('/admin/connections');
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Failed' };
  }
}

export async function deleteConnectionAction(id: string): Promise<{ ok: boolean; message?: string }> {
  try {
    await adminApi.deleteConnection(id);
    revalidatePath('/admin/connections');
    return { ok: true };
  } catch (e) {
    // Surfaces LAST_DESTINATION_REQUIRED (409) and any other API error.
    return { ok: false, message: e instanceof Error ? e.message : 'Could not disconnect.' };
  }
}

export async function toggleConnectionAction(
  id: string,
  patch: { isDestination?: boolean; checkConflicts?: boolean },
): Promise<ActionResult> {
  try {
    await adminApi.updateConnection(id, patch);
    revalidatePath('/admin/connections');
    return { ok: true };
  } catch (e) {
    // Report failure so the client can roll back its optimistic update and
    // surface the reason instead of silently persisting the wrong state.
    return { ok: false, message: e instanceof Error ? e.message : 'Update failed.' };
  }
}

export async function pingConnectionAction(
  id: string,
): Promise<{ ok: boolean; enabled: boolean; message: string }> {
  try {
    const r = await adminApi.pingConnection(id);
    return { ok: r.ok, enabled: r.enabled, message: r.message };
  } catch (e) {
    // Never throw at the boundary: a failed probe is itself a health signal.
    return { ok: false, enabled: true, message: e instanceof Error ? e.message : 'Health check failed.' };
  }
}

/**
 * The "Test / Run check" self-test — reads real busy events (not just a
 * reachability ping) so the host SEES proof conflict-checking works, instead
 * of trusting a health dot. Also persists the health outcome (same as ping).
 */
export async function testConnectionAction(id: string): Promise<ConnectionTestResult> {
  try {
    return await adminApi.testConnection(id);
  } catch (e) {
    // Never throw at the boundary: a failed self-test IS the result.
    return {
      ok: false,
      healthDetail: e instanceof Error ? e.message : 'Could not run the check.',
      busyCount: null,
      conflictCheckEnabled: false,
      checkedAt: Date.now(),
      reason: 'READ_FAILED',
    };
  }
}

/**
 * `email` is the account the host is about to connect (collected by the
 * connect dialog's "which account?" step). It becomes part of the Membrane
 * subject (`${iamUserId}-${email}`) so this connection lines up with the SAME
 * scheme the main Dapta app uses — a distinct subject per connected account is
 * what lets a member connect more than one calendar, and what makes an
 * account connected elsewhere in Dapta show up here automatically.
 */
export async function connectCalendarAction(
  provider: string,
  email: string,
): Promise<{ enabled: boolean; connectUrl: string | null; message: string }> {
  const r = await adminApi.connectionToken(provider, email);
  return { enabled: r.enabled, connectUrl: r.connectUrl, message: r.message };
}

/**
 * Called after the OAuth popup completes (and polled while it's open): persist
 * the tenant's just-connected account(s) and return the FULL up-to-date
 * connections list so the client can diff it against its pre-connect snapshot
 * by id (never by a naive count — a provider that was already connected before
 * the dialog opened has a stable count even after a fresh connect completes).
 */
export async function discoverConnectionsAction(
  provider: string,
): Promise<{ ok: boolean; connections: Connection[]; message?: string }> {
  try {
    const conns = await adminApi.discoverConnections(provider);
    revalidatePath('/admin/connections');
    return { ok: true, connections: conns };
  } catch (e) {
    return { ok: false, connections: [], message: e instanceof Error ? e.message : 'Discovery failed' };
  }
}
