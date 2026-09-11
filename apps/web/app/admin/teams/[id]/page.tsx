import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getMessages, schedulingMethodLabel } from '@slate/shared';
import { adminApi } from '@/lib/admin-api';
import { getLocale } from '@/lib/locale';
import { buttonVariants } from '@/components/ui/button';
import { FormHeader } from '@/components/ui/page-header';
import { cn } from '@/lib/cn';
import { EventRowActions } from '@/app/admin/event-types/event-row-actions';
import { TeamMembersPanel } from '../team-members-panel';

export const dynamic = 'force-dynamic';

export default async function TeamDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [me, teams] = await Promise.all([
    adminApi.me(),
    adminApi.listTeams(),
  ]);
  const team = teams.find((t) => t.id === id);
  if (!team) notFound();
  const [members, eventTypes] = await Promise.all([
    adminApi.teamMembers(id),
    adminApi.teamEventTypes(id),
  ]);
  const locale = await getLocale();
  const msgs = getMessages(locale);
  const m = msgs.admin.teams;

  return (
    <div className="mx-auto max-w-[1520px] px-gutter pb-gutter-y sm:px-gutter-wide">
      <FormHeader
        backHref="/admin/teams"
        backLabel={m.title}
        title={team.name}
        gutter="responsive"
        actions={
          me?.accountCode && team.slug ? (
            // Was `View public team page →`. The arrow is now the design
            // language's own open-in-new-tab mark, and the control is a button
            // rather than a link dressed as one.
            <Link
              href={`/${me.accountCode}/team/${team.slug}`}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(buttonVariants({ variant: 'outline', size: 'lg' }))}
            >
              <i aria-hidden className="pi pi-external-link" style={{ fontSize: 14 }} />
              {m.viewPublicTeam}
              <span className="sr-only"> ({msgs.admin.common.opensNewTab})</span>
            </Link>
          ) : undefined
        }
      />
      <p className="mb-group -mt-inline font-mono text-xs text-muted-foreground">/{team.slug}</p>

      <h2 className="mb-field text-sm font-semibold text-muted-foreground">
        {m.members} <span className="font-normal">({members.length})</span>
      </h2>
      <div className="mb-section">
        <TeamMembersPanel teamId={team.id} members={members} messages={m} locale={locale} />
      </div>

      <div className="mb-field flex flex-wrap items-center justify-between gap-field">
        <h2 className="text-sm font-semibold text-muted-foreground">{m.teamEventTypes}</h2>
        {/* The only way to CREATE a team event — the list alone was a dead end
            (QA2 fix 5). */}
        <Link
          href={`/admin/event-types/new?teamId=${team.id}`}
          className={cn(buttonVariants({ size: 'lg' }))}
        >
          {m.newTeamEvent}
        </Link>
      </div>
      <ul className="flex flex-col gap-inline">
        {eventTypes.map((et) => (
          <li
            key={et.id}
            className="flex flex-col gap-field rounded-xl border border-border bg-card p-card sm:flex-row sm:items-center sm:justify-between"
          >
            {/* Edit links carry ?from=team:<id> so the editor's back affordance
                returns HERE, not to the personal Events list (QA3 fix 4b). */}
            <Link
              href={`/admin/event-types/${et.id}?from=team:${team.id}`}
              className="flex min-w-0 flex-1 flex-col transition-colors hover:text-primary"
            >
              <span className="font-medium">{et.title}</span>
              <span className="text-sm text-muted-foreground">
                /{et.slug} · {et.lengthMinutes} min · {schedulingMethodLabel(msgs, et.schedulingType)}
              </span>
            </Link>
            <span className="shrink-0">
              <EventRowActions
                id={et.id}
                hidden={et.hidden}
                publicPath={
                  me?.accountCode && team.slug
                    ? `/${me.accountCode}/team/${team.slug}/${et.slug}`
                    : null
                }
                title={et.title}
                messages={msgs.admin.eventTypes}
                embedMessages={msgs.embed}
              />
            </span>
          </li>
        ))}
        {eventTypes.length === 0 ? (
          <li className="text-sm text-muted-foreground">{m.noTeamEventTypes}</li>
        ) : null}
      </ul>
    </div>
  );
}
