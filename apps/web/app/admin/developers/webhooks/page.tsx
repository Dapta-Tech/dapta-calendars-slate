import { getMessages } from '@slate/shared';
import { adminApi } from '@/lib/admin-api';
import { Webhooks } from '../developer-client';
import { DeveloperNoAccess, DeveloperPage, developerAccess } from '../developer-page';

export const dynamic = 'force-dynamic';

/**
 * API and webhooks, Webhooks: the URLs this workspace calls when a booking is
 * created, rescheduled or cancelled. Its own page in the group rather than a
 * corner of API keys: a webhook is the other direction (the workspace calls
 * your server; no key, no agent), with its own signing secrets and delivery
 * log. It stays in the group, and out of Settings, because it is the same
 * admin-only builder's surface it was beside on the old "MCP & API" page.
 */
export default async function DeveloperWebhooksPage() {
  const { locale, allowed } = await developerAccess();
  const admin = getMessages(locale).admin;
  const title = admin.developerNav.webhooks;
  if (!allowed) return <DeveloperNoAccess locale={locale} title={title} />;
  const webhooks = await adminApi.listWebhooks();
  return (
    // The list carries its own page header: Add webhook opens its dialog.
    <DeveloperPage>
      <Webhooks webhooks={webhooks} messages={admin.developer} locale={locale} />
    </DeveloperPage>
  );
}
