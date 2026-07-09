import { adminApi } from '@/lib/admin-api';
import { SettingsChrome } from '../settings/settings-chrome';
import { ConnectionsClient } from './connections-client';

export const dynamic = 'force-dynamic';

export default async function ConnectionsPage() {
  const connections = await adminApi.listConnections().catch(() => []);
  // Calendars lives under Settings — reuse SettingsChrome (header + sub-nav) so
  // it reads as a settings tab even though its route is /admin/connections, and
  // never drifts from the other settings pages.
  return (
    <SettingsChrome>
      <div className="max-w-3xl">
        <p className="mb-6 text-muted-foreground">
          Connected calendars. Slate reads busy times (conflict check) and can write events to a
          destination — via a generic provider port (no external calendar configured in this OSS build).
        </p>
        <ConnectionsClient connections={connections} />
      </div>
    </SettingsChrome>
  );
}
