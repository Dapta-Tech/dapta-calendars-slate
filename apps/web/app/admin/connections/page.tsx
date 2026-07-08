import { adminApi } from '@/lib/admin-api';
import { ConnectionsClient } from './connections-client';

export const dynamic = 'force-dynamic';

export default async function ConnectionsPage() {
  const connections = await adminApi.listConnections().catch(() => []);
  return (
    <div className="mx-auto max-w-3xl px-8 py-10">
      <h1 className="mb-1 text-3xl font-semibold tracking-tight">Connections</h1>
      <p className="mb-6 text-muted-foreground">
        Connected calendars. Slate reads busy times (conflict check) and can write events to a
        destination — via a generic provider port (no external calendar configured in this OSS build).
      </p>
      <ConnectionsClient connections={connections} />
    </div>
  );
}
