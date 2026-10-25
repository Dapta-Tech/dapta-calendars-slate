import { getMessages } from '@slate/shared';
import { resolveMcpConfig } from '@/lib/mcp-config';
import { ApiReference } from '../api-reference';
import { DeveloperNoAccess, DeveloperPage, developerAccess } from '../developer-page';

// Read per request: the API's public origin is runtime env (see mcp-config.ts).
export const dynamic = 'force-dynamic';

/**
 * API and webhooks, API docs: the API's own reference (the try-it console and
 * the OpenAPI document the API serves), for code that calls the API with a
 * key. Reference only, nothing here changes state. What a connected agent can
 * do, in plain words, is the Tools page's job.
 */
export default async function DeveloperDocsPage() {
  const { locale, allowed } = await developerAccess();
  const admin = getMessages(locale).admin;
  const title = admin.developerNav.docs;
  if (!allowed) return <DeveloperNoAccess locale={locale} title={title} />;
  const m = admin.developer;
  const { apiOrigin } = resolveMcpConfig();
  return (
    <DeveloperPage title={title} subtitle={m.docsPageLead}>
      <ApiReference apiOrigin={apiOrigin} messages={m} />
    </DeveloperPage>
  );
}
