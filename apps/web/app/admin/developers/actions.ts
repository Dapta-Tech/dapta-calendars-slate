'use server';

import { unstable_rethrow } from 'next/navigation';

import { revalidatePath } from 'next/cache';
import { adminApi, ApiError } from '@/lib/admin-api';
import { DEVELOPERS_KEYS_HREF, DEVELOPERS_WEBHOOKS_HREF } from '@/lib/admin-nav';
import { expiresAtMsFromDays } from '@/lib/mcp-connect';

export interface CreateApiKeyInput {
  name: string;
  scopes: string[];
  /** Limit the key to these event types; empty or absent means all of them. */
  eventTypeIds?: string[];
  /** Days until the key stops working; 0 or absent means never. */
  expiresInDays?: number;
}

export async function createApiKeyAction(input: CreateApiKeyInput): Promise<{ plaintext?: string; error?: string }> {
  try {
    // The expiry is computed here, on the server, from its own clock: a browser
    // with a wrong clock must not mint a key that is already expired.
    const expiresAtMs = expiresAtMsFromDays(input.expiresInDays ?? 0, Date.now());
    const r = await adminApi.createApiKey({
      name: input.name,
      scopes: input.scopes,
      ...(input.eventTypeIds && input.eventTypeIds.length > 0 ? { eventTypeIds: input.eventTypeIds } : {}),
      ...(expiresAtMs !== undefined ? { expiresAtMs } : {}),
    });
    revalidatePath(DEVELOPERS_KEYS_HREF);
    return { plaintext: r.plaintext };
  } catch (e) {
    unstable_rethrow(e); // let a 401→/login redirect through
    return { error: e instanceof Error ? e.message : 'Failed' };
  }
}

export async function revokeApiKeyAction(id: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await adminApi.revokeApiKey(id);
    revalidatePath(DEVELOPERS_KEYS_HREF);
    return { ok: true };
  } catch (e) {
    unstable_rethrow(e); // let a 401→/login redirect through
    return { ok: false, error: e instanceof Error ? e.message : 'Failed' };
  }
}

/** Disconnect an OAuth connection: its refresh token dies now, its access token at expiry. */
export async function revokeConnectedAppAction(id: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await adminApi.revokeConnectedApp(id);
    revalidatePath(DEVELOPERS_KEYS_HREF);
    return { ok: true };
  } catch (e) {
    unstable_rethrow(e); // let a 401→/login redirect through
    return { ok: false, error: e instanceof Error ? e.message : 'Failed' };
  }
}

/**
 * Create a webhook, returning the signing secret ONCE (W / #75).
 *
 * The secret used to be recoverable with `SELECT secret FROM webhook`; it is now
 * an envelope at rest with no read endpoint and no decrypt CLI, so this reply is
 * the only moment it can ever be learned. Discarding it — which is what this
 * action did — would leave a dashboard-created webhook signing with a secret its
 * subscriber can never verify against.
 *
 * `code` is returned alongside so the caller can tell the deployment-level
 * refusal (`INTEGRATION_KEY_MISSING`, no encryption key configured) apart from
 * an ordinary bad URL, which need different words.
 */
export async function createWebhookAction(
  subscriberUrl: string,
  triggers: string[],
): Promise<{ ok: boolean; secret?: string; error?: string; code?: string }> {
  try {
    const created = await adminApi.createWebhook({ subscriberUrl, eventTriggers: triggers });
    revalidatePath(DEVELOPERS_WEBHOOKS_HREF);
    const secret = (created as { secret?: unknown } | null)?.secret;
    return { ok: true, secret: typeof secret === 'string' ? secret : undefined };
  } catch (e) {
    unstable_rethrow(e); // let a 401→/login redirect through
    return {
      ok: false,
      error: e instanceof Error ? e.message : 'Failed',
      code: e instanceof ApiError ? e.code : undefined,
    };
  }
}

export async function deleteWebhookAction(id: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await adminApi.deleteWebhook(id);
    revalidatePath(DEVELOPERS_WEBHOOKS_HREF);
    return { ok: true };
  } catch (e) {
    unstable_rethrow(e); // let a 401→/login redirect through
    return { ok: false, error: e instanceof Error ? e.message : 'Failed' };
  }
}

export async function toggleWebhookAction(id: string, active: boolean): Promise<{ ok: boolean; error?: string }> {
  try {
    await adminApi.updateWebhook(id, active);
    revalidatePath(DEVELOPERS_WEBHOOKS_HREF);
    return { ok: true };
  } catch (e) {
    unstable_rethrow(e); // let a 401→/login redirect through
    return { ok: false, error: e instanceof Error ? e.message : 'Failed' };
  }
}

export async function webhookDeliveriesAction(
  id: string,
): Promise<{ ok: boolean; items: import('@/lib/admin-api').WebhookDeliveryRow[] }> {
  try {
    const r = await adminApi.webhookDeliveries(id);
    return { ok: true, items: r.items };
  } catch (e) {
    unstable_rethrow(e); // let a 401→/login redirect through
    return { ok: false, items: [] };
  }
}

export async function pingWebhookAction(id: string): Promise<{ ok: boolean; message: string }> {
  try {
    const r = await adminApi.pingWebhook(id);
    return { ok: r.ok, message: r.ok ? `Delivered (${r.status})` : (r.message ?? 'Failed') };
  } catch (e) {
    unstable_rethrow(e); // let a 401→/login redirect through
    return { ok: false, message: e instanceof Error ? e.message : 'Failed' };
  }
}
