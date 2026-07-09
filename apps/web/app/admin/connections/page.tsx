import { adminApi } from '@/lib/admin-api';
import { SettingsTabs } from '../settings/settings-tabs';
import { ConnectionsClient } from './connections-client';

export const dynamic = 'force-dynamic';

export default async function ConnectionsPage() {
  const connections = await adminApi.listConnections().catch(() => []);
  // Calendars lives under Settings — render the same header + sub-nav so it
  // reads as a settings tab even though its route is /admin/connections.
  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <header className="mb-6 flex flex-col gap-1">
        <h1 className="text-3xl font-semibold tracking-tight">Settings</h1>
        <p className="text-muted-foreground">Manage your account and preferences.</p>
      </header>
      <SettingsTabs />
      <div className="max-w-3xl">
        <p className="mb-6 text-muted-foreground">
          Connected calendars. Slate reads busy times (conflict check) and can write events to a
          destination — via a generic provider port (no external calendar configured in this OSS build).
        </p>
        <ConnectionsClient connections={connections} />
      </div>
    </div>
  );
}
