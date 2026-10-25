import Link from 'next/link';
import { getMessages } from '@slate/shared';
import { adminApi } from '@/lib/admin-api';
import { DEVELOPERS_TOOLS_HREF } from '@/lib/admin-nav';
import { fillMessages } from '@/lib/fill-messages';
import { claudeDirectoryUrl, resolveMcpConfig } from '@/lib/mcp-config';
import { mcpSnippets } from '@/lib/mcp-connect';
import { buttonVariants } from '@/components/ui/button';
import { McpLogos } from '@/components/mcp-logos';
import { ConnectGuide } from '../connect-guide';
import { CONNECT_VARS } from '../connect-vars';
import { DeveloperNoAccess, developerAccess } from '../developer-page';
import { stepText } from '../step-text';
import { ToolsCard } from '../tools-card';

// Read per request: the MCP address comes from the server's runtime env, which a
// prerender at build time would freeze to whatever the build machine had.
export const dynamic = 'force-dynamic';

/**
 * Connect your agent: how to connect Claude, ChatGPT, Claude Code, Codex,
 * Cursor, OpenClaw or Hermes to this product by logging in to the person's
 * account (the MCP's OAuth sign-in), no API key. The header, the recommended
 * sign-in card with a tab per app (a walkthrough on top, the steps under it),
 * then what the MCP can do, which leads to the Tools page. The same page as
 * dForms' connect page.
 *
 * The guide shows only when the API says it serves MCP and takes a sign-in
 * (its own authorization server or an external one), and the MCP address is
 * known (`resolveMcpConfig`, runtime env). Otherwise a note says the connector
 * is not available on this installation. The API answering 404 here (older
 * than OAuth) or erroring reads as no: the page never offers a sign-in that
 * cannot work. Where the connector is listed in Claude's directory
 * (`claudeDirectoryUrl`), Claude's tab starts there.
 *
 * Owners and admins only, like the rail item: a sign-in reaches only the
 * workspaces where the person is an owner or admin.
 */
export default async function DeveloperConnectPage() {
  const { locale, allowed } = await developerAccess();
  const admin = getMessages(locale).admin;
  if (!allowed) return <DeveloperNoAccess locale={locale} title={admin.nav.connect} />;
  const c = fillMessages(admin.connect, CONNECT_VARS);
  const tools = fillMessages(admin.tools, CONNECT_VARS);
  const signIn = await adminApi.connectedApps().then(
    (r) => r.mcpEnabled === true && (r.enabled || r.external === true),
    () => false,
  );
  const { mcpUrl } = resolveMcpConfig();
  const url = signIn ? mcpUrl : null;

  return (
    <div className="mx-auto max-w-5xl px-gutter py-section sm:px-gutter-wide sm:py-gutter-y">
      <header className="mb-section flex flex-col gap-card sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="mb-inline flex items-center gap-inline text-xs font-semibold uppercase tracking-wider text-signal-ink">
            <McpLogos size={16} />
            {c.eyebrow}
          </p>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">{c.heading}</h1>
          <p className="mt-inline max-w-2xl text-muted-foreground">{c.intro}</p>
        </div>
        <Link
          href={DEVELOPERS_TOOLS_HREF}
          data-testid="tools-link"
          className={`${buttonVariants({ variant: 'soft' })} shrink-0 self-start`}
        >
          <i aria-hidden className="pi pi-sparkles" style={{ fontSize: 13 }} />
          {admin.nav.tools}
        </Link>
      </header>

      <div className="flex flex-col gap-group">
        {url ? (
          <ConnectGuide m={c} snippets={mcpSnippets(url, claudeDirectoryUrl())} />
        ) : (
          <section
            data-testid="mcp-connect-unavailable"
            className="rounded-2xl border border-dashed border-border bg-card/40 px-card py-group sm:px-group"
          >
            <h2 className="flex items-center gap-inline font-semibold text-foreground">
              <i aria-hidden className="pi pi-info-circle text-muted-foreground" style={{ fontSize: 15 }} />
              {c.unavailableTitle}
            </h2>
            <p className="mt-tight text-sm text-muted-foreground">{stepText(c.unavailableBody)}</p>
          </section>
        )}

        <ToolsCard connect={c} tools={tools} />
      </div>
    </div>
  );
}
