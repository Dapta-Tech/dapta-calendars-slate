'use server';

import { revalidatePath } from 'next/cache';
import { unstable_rethrow } from 'next/navigation';
import type { IntegrationStatusView } from '@slate/types';
import { adminApi, ApiError } from '@/lib/admin-api';
import { connectFailure, type ConnectFailure } from './status';

/**
 * Connect / disconnect for the Integrations tab (H1b / #93).
 *
 * The pasted token goes client → HERE → API and stops. What comes back is the
 * token-free `IntegrationStatusView` the API already projects, so there is no
 * point in this file where a credential could be returned to the browser even
 * by accident.
 *
 * A failure comes back as a discriminated REASON, never as the server's own
 * message: the copy the host reads is the locale catalog's, and passing prose
 * through would both dodge i18n and risk echoing whatever the provider said
 * about a string we just refused to store.
 *
 * `unstable_rethrow` lets the client's 401→/login redirect escape the catch.
 */

export type ConnectResult =
  | { ok: true; status: IntegrationStatusView }
  | { ok: false; failure: ConnectFailure };

export async function connectIntegrationAction(
  provider: string,
  token: string,
  label?: string,
): Promise<ConnectResult> {
  try {
    const status = await adminApi.connectIntegration({
      provider,
      token,
      // An empty box means "no label", not a label that is the empty string.
      label: label?.trim() ? label.trim() : undefined,
    });
    revalidatePath('/admin/settings/integrations');
    return { ok: true, status };
  } catch (e) {
    unstable_rethrow(e);
    if (e instanceof ApiError) return { ok: false, failure: connectFailure(e.code, e.details) };
    return { ok: false, failure: { kind: 'generic' } };
  }
}

export async function disconnectIntegrationAction(
  provider: string,
): Promise<{ ok: boolean; disconnected: boolean }> {
  try {
    // `disconnected: false` is a successful call that changed nothing — there
    // was no credential to scrub. Propagated rather than flattened into `ok`,
    // so the UI cannot report success and flip the card for a no-op the next
    // page load would contradict.
    const res = await adminApi.disconnectIntegration(provider);
    revalidatePath('/admin/settings/integrations');
    return { ok: true, disconnected: res.disconnected === true };
  } catch (e) {
    unstable_rethrow(e);
    return { ok: false, disconnected: false };
  }
}
