import Link from 'next/link';
import type { BookingMessages } from '@slate/shared';
import { DEVELOPERS_TOOLS_HREF } from '@/lib/admin-nav';
import { TOOL_GROUPS, TOOL_GROUP_ICONS, TOOL_GROUP_ORDER } from './tool-groups';

type AdminMessages = BookingMessages['admin'];

/**
 * "What you can do with the MCP" on the connect page: the groups of tools,
 * each with what it covers and how many tools it holds, and the way to the
 * Tools page, where every tool is spelled out with an example request. Both
 * sections arrive with their names filled in (`fillMessages`).
 */
export function ToolsCard({ connect, tools }: { connect: AdminMessages['connect']; tools: AdminMessages['tools'] }) {
  return (
    <section
      aria-labelledby="mcp-tools-title"
      data-testid="mcp-tools"
      className="rounded-2xl border border-border bg-card px-card py-group sm:px-group"
    >
      <div className="flex flex-wrap items-end justify-between gap-field">
        <div className="min-w-0">
          <h2 id="mcp-tools-title" className="text-lg font-semibold text-foreground">
            {connect.toolsTitle}
          </h2>
          <p className="mt-tight text-sm text-muted-foreground">{connect.toolsIntro}</p>
        </div>
        <Link
          href={DEVELOPERS_TOOLS_HREF}
          data-testid="mcp-tools-link"
          className="inline-flex min-h-control items-center gap-tight text-sm font-medium text-foreground hover:underline"
        >
          {connect.toolsLink}
          <i aria-hidden className="pi pi-arrow-right" style={{ fontSize: 12 }} />
        </Link>
      </div>
      <ul className="mt-group grid gap-field sm:grid-cols-2 lg:grid-cols-3">
        {TOOL_GROUP_ORDER.map((group) => (
          <li key={group} data-testid={`mcp-tools-${group}`}>
            <Link
              href={`${DEVELOPERS_TOOLS_HREF}#${group}`}
              className="flex h-full flex-col rounded-xl border border-border bg-panel p-card transition-colors hover:border-foreground/20 active:scale-[0.99]"
            >
              <span className="flex items-center justify-between gap-inline">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-signal/15 text-signal-ink">
                  <i aria-hidden className={`pi ${TOOL_GROUP_ICONS[group]}`} style={{ fontSize: 14 }} />
                </span>
                <span className="flex h-5 items-center rounded-full bg-card px-inline font-mono text-2xs font-medium text-muted-foreground">
                  {TOOL_GROUPS[group].length}
                </span>
              </span>
              <span className="mt-field text-sm font-semibold text-foreground">{tools.groups[group].title}</span>
              <span className="mt-tight text-sm text-muted-foreground">{tools.groups[group].body}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
