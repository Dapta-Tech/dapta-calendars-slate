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
  const messages = getMessages(await getLocale()).admin.settings;
  // Calendars lives under Settings — reuse SettingsChrome (header + sub-nav) so
  // it reads as a settings tab even though its route is /admin/connections.
  return (
    <SettingsChrome messages={messages}>
      <div className="max-w-3xl">
        <p className="mb-6 text-muted-foreground">
          Connect a calendar so Slate can check conflicts (busy times) and write your booked events to it.
        </p>
        <ConnectionsClient
          connections={connections}
          status={{ enabled: token.enabled, message: token.message }}
        />
      </div>
    </SettingsChrome>
  );
}
