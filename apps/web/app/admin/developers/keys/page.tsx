import { getMessages, t, type BookingMessages } from '@slate/shared';
import { adminApi } from '@/lib/admin-api';
import { resolveMcpConfig } from '@/lib/mcp-config';
import { ConnectedApps } from '../connected-apps';
import { ApiKeys } from '../developer-client';
import { DeveloperNoAccess, DeveloperPage, developerAccess } from '../developer-page';
import { SkillDownload } from '../skill-download';
import { PRODUCT_NAME } from '@/lib/product-name';
import type { ConnectedApps as ConnectedAppsList } from '@/lib/admin-api';

type DevMessages = BookingMessages['admin']['developer'];

/**
 * What the page assumes when it cannot ask the API: OAuth off. An API older
 * than OAuth answers 404 here, and one that errors says nothing about its
 * connections either, so the Connected apps list stays out.
 */
const NO_OAUTH: ConnectedAppsList = { enabled: false, mcpEnabled: false, accessTokenTtlSeconds: null, grants: [] };

// Read per request: the API's public origin comes from the server's runtime env,
// which a prerender at build time would freeze to whatever the build machine had.
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
 * API and webhooks, API keys: the keys a script, a CRM or a headless agent
 * uses with the REST API and the MCP server, the skill that teaches an agent
 * with a terminal that API, and the apps that signed in through this API's own
 * OAuth server. Keys and connected apps share the page because they are the
 * two credentials that act on this workspace from outside: everything of that
 * kind is listed, and revoked, in one place.
 *
 * Connecting an AI app with the person's account, no key, is the connect
 * page's job ("Connect your agent"), so nothing here walks through it.
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
    adminApi.connectedApps().catch(() => NO_OAUTH),
  ]);
  const m = admin.developer;
  // Sign-in through an external authorization server keeps its connections
  // there: no consent page or Connected apps list of ours.
  const external = oauth.external === true;
  // The skill zip is written for the API's public origin: with none, the page
  // says so instead of offering a download that would fail.
  const { apiOrigin } = resolveMcpConfig();
  return (
    <DeveloperPage title={title} subtitle={m.pageLead}>
      <ApiKeys keys={keys} eventTypes={eventTypes} now={Date.now()} messages={m} locale={locale} />
      <SkillSection m={m} available={apiOrigin !== null} />
      {oauth.enabled && !external ? (
        <ConnectedApps apps={oauth.grants} accessTokenTtlSeconds={oauth.accessTokenTtlSeconds ?? 3600} messages={m} locale={locale} />
      ) : null}
    </DeveloperPage>
  );
}

/**
 * The way in for an agent with a terminal and no MCP: a zip that teaches it the
 * REST API with the same key. Built on the server for this installation; with
 * no public API address there is nothing to write into it, so the section says
 * so instead. A download that fails anyway (the session ended meanwhile) says
 * why in place.
 */
function SkillSection({ m, available }: { m: DevMessages; available: boolean }) {
  return (
    <section data-testid="setup-skill" aria-labelledby="setup-skill-title" className="mb-section">
      <h2 id="setup-skill-title" className="mb-tight text-xl font-semibold">
        {m.guideSkillTitle}
      </h2>
      <p className="max-w-prose text-sm text-muted-foreground">{t(m.guideSkillBody, { product: PRODUCT_NAME })}</p>
      {available ? (
        <SkillDownload m={m} />
      ) : (
        <p data-testid="setup-skill-unavailable" className="mt-field max-w-prose text-sm text-muted-foreground">
          {m.guideSkillUnavailable}
        </p>
      )}
    </section>
  );
}
