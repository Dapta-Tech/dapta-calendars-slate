/**
 * @slate/crm — the `CrmProvider` port and its adapters.
 *
 * Open core and vendor-named, by ADR 0001: R15 governs CALENDAR vendors only,
 * and a CRM integration built on a public API plus a user-pasted token has no
 * Dapta-side credential or contract to protect. A bare fork gets a working
 * integration rather than an empty seam.
 *
 * Selection mirrors the calendar and entitlements ports: a disabled no-op
 * default plus one real adapter, chosen by env.
 */
export * from './port';
export * from './hubspot';
export * from './meeting-body';
export * from './mapping';

import { DisabledCrmProvider, type CrmProvider } from './port';
import { HubSpotCrmProvider, HUBSPOT_API_BASE_URL } from './hubspot';

/**
 * Env-driven selection (mirrors `resolveCalendarProvider`).
 *
 * `CRM_API_BASE_URL` defaults to the vendor's public host and exists for two
 * real cases: a self-hoster whose egress goes through a proxy, and exercising
 * the integration end-to-end against a stub without stubbing anything in
 * product code. It is the same knob `CALENDAR_API_BASE_URL` already is.
 */
export function resolveCrmProvider(
  env: { CRM_PROVIDER?: string; CRM_HTTP_TIMEOUT_MS?: number; CRM_API_BASE_URL?: string },
  fetchImpl?: typeof fetch,
): CrmProvider {
  if (env.CRM_PROVIDER === 'hubspot') {
    return new HubSpotCrmProvider(
      env.CRM_API_BASE_URL?.trim() || HUBSPOT_API_BASE_URL,
      env.CRM_HTTP_TIMEOUT_MS ?? 10_000,
      fetchImpl,
    );
  }
  return new DisabledCrmProvider();
}
