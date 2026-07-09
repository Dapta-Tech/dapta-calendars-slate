import { adminApi } from '@/lib/admin-api';
import { ApiKeys, Webhooks } from './developer-client';

export const dynamic = 'force-dynamic';

export default async function DeveloperSettings() {
  const [keys, webhooks] = await Promise.all([
    adminApi.listApiKeys().catch(() => []),
    adminApi.listWebhooks().catch(() => []),
  ]);
  return (
    <div className="flex max-w-3xl flex-col gap-8">
      <ApiKeys keys={keys} />
      <Webhooks webhooks={webhooks} />
    </div>
  );
}
