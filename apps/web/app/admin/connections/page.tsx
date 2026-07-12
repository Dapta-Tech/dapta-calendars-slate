import { getMessages } from '@slate/shared';
import { adminApi } from '@/lib/admin-api';
import { getLocale } from '@/lib/locale';
import { PageHeader } from '@/components/ui/page-header';
import { ConnectionsClient } from './connections-client';

export const dynamic = 'force-dynamic';

export default async function ConnectionsPage() {
  const [connections, token] = await Promise.all([
    adminApi.listConnections(),
    // Provider status: enabled only when an external calendar adapter is wired.
    adminApi.connectionToken().catch(() => ({ enabled: false, message: 'Calendar sync unavailable.' })),
  ]);
  const admin = getMessages(await getLocale()).admin;
  // Calendars is a top-level admin surface (rail item), styled like the other
  // list pages: PageHeader + content column. The primary Connect action lives
  // inside ConnectionsClient's header row (R30 list/create pattern).
  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <PageHeader title={admin.nav.calendars} subtitle={admin.connections.pageDesc} />
      <div className="max-w-3xl">
        <ConnectionsClient
          connections={connections}
          status={{ enabled: token.enabled, message: token.message }}
          messages={admin.connections}
        />
      </div>
    </div>
  );
}
