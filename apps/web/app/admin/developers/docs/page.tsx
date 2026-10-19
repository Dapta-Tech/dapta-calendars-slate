import { getMessages } from '@slate/shared';
import { resolveMcpConfig } from '@/lib/mcp-config';
import { ApiReference } from '../api-reference';
import { AgentTools } from '../connect-agent';
import { DeveloperNoAccess, DeveloperPage, developerAccess } from '../developer-page';

// Read per request: the API's public origin is runtime env (see mcp-config.ts).
export const dynamic = 'force-dynamic';

/**
 * MCP, API docs: what a key can call. The MCP tools with the access each one
 * needs, then the API's own reference (the try-it console and the OpenAPI
 * document the API serves). Reference only, nothing here changes state.
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
      <AgentTools messages={m} />
      <ApiReference apiOrigin={apiOrigin} messages={m} />
    </DeveloperPage>
  );
}
