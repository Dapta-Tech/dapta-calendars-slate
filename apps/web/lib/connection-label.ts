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
 *
 * NOT the same fallback as the Connections page's own `connectionLabel` in
 * `connections-client.tsx`, which — once no email/id is derivable — shows a
 * localized, muted "account unknown" caption instead of the provider name
 * (that page needs to visually distinguish an unresolved account from a
 * legitimate label). This module intentionally stays import-free (no i18n
 * messages object available here), so it falls back to the plain provider
 * name instead; this call site (the per-event calendar picker, a secondary
 * read-only list) doesn't need the same "unknown" affordance.
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
