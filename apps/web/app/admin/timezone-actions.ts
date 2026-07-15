'use server';

import { revalidatePath } from 'next/cache';
import { adminApi } from '@/lib/admin-api';

/**
 * One-time browser-timezone catch-up (AdminService.syncClientTimeZone): the
 * server never knows the visitor's real IANA timezone, so the client reports
 * it once on first mount. No-op server-side once the member already has an
 * explicit (non-'UTC') timezone — never silently overrides a manual choice
 * made in Settings → General.
 */
export async function syncTimeZoneAction(timeZone: string): Promise<void> {
  if (!timeZone) return;
  const r = await adminApi.syncTimeZone(timeZone);
  if (r.ok) revalidatePath('/admin', 'layout');
}
