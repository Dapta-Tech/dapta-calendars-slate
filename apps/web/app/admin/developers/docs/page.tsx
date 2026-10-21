import { getMessages } from '@slate/shared';
import { adminApi } from '@/lib/admin-api';
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
 *
 * The tool list describes the MCP endpoint, so it shows only when the API says
 * it serves MCP (`mcpEnabled`, the same read and the same fail-closed rule as
 * Connect and keys); otherwise the page says so in one sentence. The API
 * reference does not depend on MCP and shows either way.
 */
export default async function DeveloperDocsPage() {
  const { locale, allowed } = await developerAccess();
  const admin = getMessages(locale).admin;
  const title = admin.developerNav.docs;
  if (!allowed) return <DeveloperNoAccess locale={locale} title={title} />;
  const m = admin.developer;
  const { mcpEnabled, signIn } = await adminApi.connectedApps().then(
    // A sign-in (OAuth on, this API's own server or an external one) also
    // works for the tools that need no particular scope.
    (r) => ({ mcpEnabled: r.mcpEnabled === true, signIn: r.enabled || r.external === true }),
    () => ({ mcpEnabled: false, signIn: false }),
  );
  const { apiOrigin } = resolveMcpConfig();
  return (
    <DeveloperPage title={title} subtitle={m.docsPageLead}>
      {mcpEnabled ? (
        <AgentTools messages={m} signIn={signIn} />
      ) : (
        <p data-testid="mcp-unavailable" className="mb-section max-w-prose text-sm text-muted-foreground">
          {m.mcpUnavailable}
        </p>
      )}
      <ApiReference apiOrigin={apiOrigin} messages={m} />
    </DeveloperPage>
  );
}
