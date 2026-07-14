/**
 * Human label for a connection: account email first, else a readable manual
 * calendar id, else the end-provider name (Google/Outlook — R15-safe: these
 * are end-provider names, not the integration vendor).
 *
 * Deliberately its own module (no imports) — `admin-api.ts` depends on
 * `auth-session.ts` (`next/headers`, server-only). A CLIENT component that
 * imports a VALUE (not just a type) from `admin-api.ts` pulls that whole
 * server-only graph into the browser bundle and fails to compile. Client
 * components (e.g. the per-event calendar picker) must import this function
 * from HERE, not from `admin-api.ts`.
 */
export interface ConnectionLabelInput {
  primaryEmail: string | null;
  externalId: string;
  provider: string;
}

export function connectionDisplayLabel(c: ConnectionLabelInput): string {
  if (c.primaryEmail) return c.primaryEmail;
  if (c.externalId.includes('@')) return c.externalId;
  const p = c.provider.toLowerCase();
  if (p.includes('google')) return 'Google Calendar';
  if (p.includes('outlook') || p.includes('microsoft')) return 'Outlook / Microsoft 365';
  return c.provider.charAt(0).toUpperCase() + c.provider.slice(1);
}
