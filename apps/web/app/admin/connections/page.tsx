import { getMessages } from '@slate/shared';
import { adminApi } from '@/lib/admin-api';
import { getLocale } from '@/lib/locale';
import { SettingsChrome } from '../settings/settings-chrome';
import { ConnectionsClient } from './connections-client';

export const dynamic = 'force-dynamic';

export default async function ConnectionsPage() {
  const [connections, token] = await Promise.all([
    adminApi.listConnections(),
    // Provider status: enabled only when an external calendar adapter is wired.
    adminApi.connectionToken().catch(() => ({ enabled: false, message: 'Calendar sync unavailable.' })),
  ]);
  const admin = getMessages(await getLocale()).admin;
  // Calendars lives under Settings — reuse SettingsChrome (header + sub-nav) so
  // it reads as a settings tab even though its route is /admin/connections.
  return (
    <SettingsChrome messages={admin.settings}>
      <div className="max-w-3xl">
        <p className="mb-6 text-muted-foreground">{admin.connections.pageDesc}</p>
        <ConnectionsClient
          connections={connections}
          status={{ enabled: token.enabled, message: token.message }}
          messages={admin.connections}
        />
      </div>
    </SettingsChrome>
  );
}
