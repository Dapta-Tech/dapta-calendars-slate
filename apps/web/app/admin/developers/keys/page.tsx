import { getMessages } from '@slate/shared';
import { adminApi } from '@/lib/admin-api';
import {
  claudeCodeCommand,
  claudeConnectorLink,
  codexConfigToml,
  cursorDeeplink,
  cursorMcpJson,
  exportKeyCommand,
  genericConnection,
} from '@/lib/mcp-connect';
import { resolveMcpConfig } from '@/lib/mcp-config';
import type { ConnectSnippets } from '../connect-agent';
import { DeveloperNoAccess, DeveloperPage, developerAccess } from '../developer-page';
import { KeysPanel } from '../keys-panel';
import { PRODUCT_NAME } from '@/lib/product-name';
import type { McpSwitches } from '@/lib/admin-api';

/**
 * What the page assumes when it cannot ask the API: OAuth off and MCP off. An
 * API older than OAuth answers 404 here, and one that errors is no proof that
 * `/mcp` answers either, so both fail closed.
 */
const NO_OAUTH: McpSwitches = { mcpEnabled: false };

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

/**
 * MCP, Connect and keys: the three-step guide that connects an agent (create a
 * key, connect the agent, ask it something) and the keys themselves. A sign-in
 * through the external authorization server is the other way in; that server
 * keeps those connections, and an owner removes the member or their admin role
 * to cut one off.
 */
export default async function DeveloperKeysPage() {
  const { locale, allowed } = await developerAccess();
  const admin = getMessages(locale).admin;
  const title = admin.developerNav.keys;
  if (!allowed) return <DeveloperNoAccess locale={locale} title={title} />;
  const [keys, eventTypes, oauth] = await Promise.all([
    adminApi.listApiKeys(),
    // The allowlist picker is optional: a failure here must not take the page down.
    allowlistEventTypes().catch(() => []),
    adminApi.mcpSwitches().catch(() => NO_OAUTH),
  ]);
  const m = admin.developer;
  // The web's MCP_PUBLIC_URL says where MCP would answer, not whether it does:
  // only the API knows that (MCP_ENABLED). No connection steps, and no address,
  // unless it says yes; an older API without the field reads as no.
  const mcpEnabled = oauth.mcpEnabled === true;
  // Sign-in through the external authorization server (OAuth on).
  const external = oauth.external === true;
  // The API's public origin is also what the skill zip is written for: with
  // none, the guide shows a line instead of a download that would fail.
  const { mcpUrl, apiOrigin } = resolveMcpConfig();
  const snippets: ConnectSnippets | null = mcpEnabled && mcpUrl
    ? {
        mcpUrl,
        cursorDeeplink: cursorDeeplink(mcpUrl),
        cursorJson: cursorMcpJson(mcpUrl),
        claudeCode: claudeCodeCommand(mcpUrl),
        codexToml: codexConfigToml(mcpUrl),
        exportKey: exportKeyCommand(),
        header: genericConnection(mcpUrl).header,
        claudeConnector: claudeConnectorLink(mcpUrl, PRODUCT_NAME),
      }
    : null;
  return (
    <DeveloperPage title={title} subtitle={m.pageLead}>
      <KeysPanel
        keys={keys}
        eventTypes={eventTypes}
        now={Date.now()}
        mcpAvailable={mcpEnabled}
        snippets={snippets}
        oauth={external}
        productName={PRODUCT_NAME}
        docsLabel={admin.developerNav.docs}
        skillAvailable={apiOrigin !== null}
        messages={m}
        locale={locale}
      />
    </DeveloperPage>
  );
}
