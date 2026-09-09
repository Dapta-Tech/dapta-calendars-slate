import { unstable_rethrow } from 'next/navigation';
import { getMessages } from '@slate/shared';
import type { IntegrationCapabilities, IntegrationStatusView } from '@slate/types';
import { adminApi, isAdminRole } from '@/lib/admin-api';
import { getLocale } from '@/lib/locale';
import { NoAccess } from '@/components/no-access';
import { IntegrationsPanel } from './integrations-client';

export const dynamic = 'force-dynamic';

/**
 * Integrations (H1b / #93) — the host-facing half of the CRM integration whose
 * engine shipped in H1a (#116).
 *
 * Admin/owner only: the credential is an ACCOUNT-level resource, so the API
 * 403s a plain member on every route. Gated here too, for a sentence instead of
 * a broken page.
 */
export default async function IntegrationsSettings() {
  const [me, locale] = await Promise.all([adminApi.me(), getLocale()]);
  if (!isAdminRole(me.role)) {
    const nm = getMessages(locale).admin.members;
    return <NoAccess title={nm.noAccessTitle} body={nm.noAccessBody} />;
  }

  // Fetched and failed SEPARATELY. They answer different questions — what this
  // ACCOUNT has connected, and what this DEPLOYMENT can do — and a failure of
  // one must not blank the other. A failed capabilities read degrades to "not
  // enabled", which is the safe direction: it withholds a Connect button rather
  // than offering one that cannot work.
  let rows: IntegrationStatusView[] = [];
  let loadError = false;
  try {
    rows = await adminApi.listIntegrations();
  } catch (e) {
    unstable_rethrow(e); // let a 401→/login redirect through
    loadError = true;
  }

  let capabilities: IntegrationCapabilities | null = null;
  try {
    capabilities = await adminApi.integrationCapabilities();
  } catch (e) {
    unstable_rethrow(e);
  }

  const m = getMessages(locale).admin.integrations;
  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <p className="max-w-prose text-sm text-muted-foreground">{m.pageLead}</p>
      <IntegrationsPanel
        rows={rows}
        capabilities={capabilities}
        loadError={loadError}
        locale={locale}
        // Explicit, so the health timestamp formats identically on the server
        // and in the browser. A zone-less formatter in a client component
        // renders in the server's zone and hydrates in the reader's.
        timeZone={me.timeZone ?? 'UTC'}
        messages={m}
      />
    </div>
  );
}
