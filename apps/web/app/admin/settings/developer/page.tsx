import { adminApi } from '@/lib/admin-api';
import { ApiKeys, Webhooks } from './developer-client';

export const dynamic = 'force-dynamic';

export default async function DeveloperSettings() {
  const [keys, webhooks] = await Promise.all([
    adminApi.listApiKeys().catch(() => []),
    adminApi.listWebhooks().catch(() => []),
  ]);
  return (
    <div className="mx-auto max-w-3xl px-8 py-10">
      <h1 className="mb-6 text-3xl font-semibold tracking-tight">Developer</h1>
      <ApiKeys keys={keys} />
      <Webhooks webhooks={webhooks} />
    </div>
  );
}
