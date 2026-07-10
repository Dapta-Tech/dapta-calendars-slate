import { getMessages } from '@slate/shared';
import { adminApi } from '@/lib/admin-api';
import { getLocale } from '@/lib/locale';
import { ApiKeys, Webhooks } from './developer-client';

export const dynamic = 'force-dynamic';

export default async function DeveloperSettings() {
  const [keys, webhooks, locale] = await Promise.all([
    adminApi.listApiKeys(),
    adminApi.listWebhooks(),
    getLocale(),
  ]);
  const m = getMessages(locale).admin.developer;
  return (
    <div className="flex max-w-3xl flex-col gap-8">
      <ApiKeys keys={keys} messages={m} />
      <Webhooks webhooks={webhooks} messages={m} />
    </div>
  );
}
