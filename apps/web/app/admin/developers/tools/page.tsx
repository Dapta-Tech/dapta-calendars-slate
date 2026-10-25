import Link from 'next/link';
import { getMessages, t } from '@slate/shared';
import { DEVELOPERS_CONNECT_HREF } from '@/lib/admin-nav';
import { fillMessages } from '@/lib/fill-messages';
import { buttonVariants } from '@/components/ui/button';
import { CONNECT_VARS } from '../connect-vars';
import { DeveloperNoAccess, developerAccess } from '../developer-page';
import { TOOL_GROUPS, TOOL_GROUP_ICONS, TOOL_GROUP_ORDER } from '../tool-groups';

/**
 * Tools: what an agent can do in this product once it is connected, in plain
 * words. Every tool of the MCP server, grouped like the connect page, each
 * with a one-line description and an example of what a person would ask. No
 * routes, no parameters, no JSON: the agent picks the tool, the person only
 * asks. The same page as dForms' Tools page.
 *
 * The names come from `TOOL_GROUPS`, which a spec holds to the server's
 * catalog, and the copy is keyed by those names in both languages, so the
 * page never drifts from what the MCP really offers. Owners and admins only,
 * like the rail item and the connect page it leads to.
 */
export default async function ToolsPage() {
  const { locale, allowed } = await developerAccess();
  const admin = getMessages(locale).admin;
  if (!allowed) return <DeveloperNoAccess locale={locale} title={admin.nav.tools} />;
  const x = fillMessages(admin.tools, CONNECT_VARS);
  return (
    <div className="mx-auto max-w-5xl px-gutter py-section sm:px-gutter-wide sm:py-gutter-y">
      <header className="mb-section flex flex-col gap-card sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">{x.title}</h1>
          <p className="mt-inline max-w-2xl text-muted-foreground">{x.intro}</p>
        </div>
        <Link
          href={DEVELOPERS_CONNECT_HREF}
          data-testid="tools-connect-link"
          className={`${buttonVariants({ variant: 'default' })} shrink-0 self-start`}
        >
          {x.connectCta}
          <i aria-hidden className="pi pi-arrow-right" style={{ fontSize: 12 }} />
        </Link>
      </header>

      <nav aria-label={x.title} className="mb-section flex flex-wrap gap-inline">
        {TOOL_GROUP_ORDER.map((group) => (
          <a
            key={group}
            href={`#${group}`}
            className="flex min-h-control items-center rounded-full border border-border bg-card px-field text-sm text-muted-foreground transition-colors hover:text-foreground active:scale-[0.98] sm:min-h-8"
          >
            {x.groups[group].title}
          </a>
        ))}
      </nav>

      <div className="flex flex-col gap-group">
        {TOOL_GROUP_ORDER.map((group) => (
          <section
            key={group}
            id={group}
            aria-labelledby={`tools-${group}`}
            data-testid={`tools-group-${group}`}
            className="scroll-mt-group rounded-2xl border border-border bg-card px-card py-group sm:px-group"
          >
            <div className="flex items-start gap-field">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-signal/15 text-signal-ink">
                <i aria-hidden className={`pi ${TOOL_GROUP_ICONS[group]}`} style={{ fontSize: 16 }} />
              </span>
              <div className="min-w-0">
                <h2 id={`tools-${group}`} className="text-lg font-semibold text-foreground">
                  {x.groups[group].title}
                  <span className="ml-inline align-middle text-xs font-medium text-muted-foreground">
                    {TOOL_GROUPS[group].length === 1 ? x.countOne : t(x.count, { n: TOOL_GROUPS[group].length })}
                  </span>
                </h2>
                <p className="text-sm text-muted-foreground">{x.groups[group].body}</p>
              </div>
            </div>
            <ul className="mt-card grid gap-field md:grid-cols-2">
              {TOOL_GROUPS[group].map((name) => {
                const item = x.items[name];
                return (
                  <li
                    key={name}
                    data-testid="tools-item"
                    data-tool={name}
                    className="flex flex-col gap-inline rounded-xl border border-border bg-panel p-card"
                  >
                    <p className="text-sm font-medium text-foreground">{item?.what}</p>
                    <p className="flex gap-inline rounded-lg bg-card px-field py-inline text-sm text-muted-foreground">
                      <span aria-hidden className="flex h-5 shrink-0 items-center text-signal-ink">
                        <i className="pi pi-comment" style={{ fontSize: 13 }} />
                      </span>
                      <span>
                        <span className="font-medium text-foreground">{x.askLabel}</span>{' '}
                        <span className="italic">{item?.ask}</span>
                      </span>
                    </p>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
