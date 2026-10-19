import { getMessages } from '@slate/shared';
import { adminApi, isAdminRole } from '@/lib/admin-api';
import { getLocale } from '@/lib/locale';
import {
  claudeCodeCommand,
  codexConfigToml,
  cursorDeeplink,
  cursorMcpJson,
  exportKeyCommand,
  genericConnection,
} from '@/lib/mcp-connect';
import { resolveMcpConfig } from '@/lib/mcp-config';
import { NoAccess } from '@/components/no-access';
import { ApiReference } from './api-reference';
import { AgentTools, ConnectAgent, type ConnectSnippets } from './connect-agent';
import { ApiKeys, Webhooks } from './developer-client';

// Read per request: the MCP address comes from the server's runtime env, which a
// prerender at build time would freeze to whatever the build machine had.
export const dynamic = 'force-dynamic';

/**
 * Every event type an admin can scope a key to: their own plus each team's, the
 * same set the Events page shows. `GET /v1/event-types` alone returns only the
 * caller's personal ones, so a key could never be limited to a team event.
 */
async function allowlistEventTypes(): Promise<{ id: string; title: string }[]> {
  const [own, teams] = await Promise.all([adminApi.listEventTypes(), adminApi.listTeams()]);
  const perTeam = await Promise.all(
    teams.map(async (team) =>
      (await adminApi.teamEventTypes(team.id)).map((e) => ({ id: e.id, title: `${e.title} (${team.name})` })),
    ),
  );
  const seen = new Set<string>();
  return [...own.map((e) => ({ id: e.id, title: e.title })), ...perTeam.flat()].filter((e) =>
    seen.has(e.id) ? false : (seen.add(e.id), true),
  );
}

export default async function DeveloperSettings() {
  const [me, locale] = await Promise.all([adminApi.me(), getLocale()]);
  // MCP & API (API keys + webhooks) is admin/owner-only; the API 403s for a
  // plain member, so gate here for a graceful message. The route keeps its old
  // `/developer` path so existing links and bookmarks still land here.
  if (!isAdminRole(me.role)) {
    const nm = getMessages(locale).admin.members;
    return <NoAccess title={nm.noAccessTitle} body={nm.noAccessBody} />;
  }
  const [keys, webhooks, eventTypes] = await Promise.all([
    adminApi.listApiKeys(),
    adminApi.listWebhooks(),
    // The allowlist picker is optional: a failure here must not take the page down.
    allowlistEventTypes().catch(() => []),
  ]);
  const m = getMessages(locale).admin.developer;
  const { mcpUrl, apiOrigin } = resolveMcpConfig();
  const snippets: ConnectSnippets | null = mcpUrl
    ? {
        mcpUrl,
        cursorDeeplink: cursorDeeplink(mcpUrl),
        cursorJson: cursorMcpJson(mcpUrl),
        claudeCode: claudeCodeCommand(mcpUrl),
        codexToml: codexConfigToml(mcpUrl),
        exportKey: exportKeyCommand(),
        header: genericConnection(mcpUrl).header,
      }
    : null;
  return (
    <div className="flex max-w-3xl flex-col gap-section">
      {/* Page-level lead: who this page is for (QA2 fix 4). */}
      <p className="max-w-prose text-sm text-muted-foreground">{m.pageLead}</p>
      <ConnectAgent snippets={snippets} messages={m} />
      <ApiKeys
        keys={keys}
        eventTypes={eventTypes}
        now={Date.now()}
        messages={m}
        locale={locale}
      />
      <AgentTools messages={m} />
      <Webhooks webhooks={webhooks} messages={m} locale={locale} />
      <ApiReference apiOrigin={apiOrigin} messages={m} />
    </div>
  );
}
