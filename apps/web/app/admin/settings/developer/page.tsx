import { adminApi } from '@/lib/admin-api';
import { ApiKeys, Webhooks } from './developer-client';

export const dynamic = 'force-dynamic';

export default async function DeveloperSettings() {
  const [keys, webhooks] = await Promise.all([
    adminApi.listApiKeys(),
    adminApi.listWebhooks(),
  ]);
  return (
    <div className="flex max-w-3xl flex-col gap-8">
      <ApiKeys keys={keys} />
      <Webhooks webhooks={webhooks} />
    </div>
  );
}
