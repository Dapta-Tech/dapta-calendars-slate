import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getMessages, schedulingMethodLabel } from '@slate/shared';
import { adminApi } from '@/lib/admin-api';
import { getLocale } from '@/lib/locale';
import { FormHeader } from '@/components/ui/page-header';
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
    <div className="mx-auto max-w-[1520px] px-8 pb-10">
      <FormHeader
        backHref="/admin/teams"
        backLabel={m.title}
        title={team.name}
        actions={
          me?.accountCode && team.slug ? (
            <Link
              href={`/${me.accountCode}/team/${team.slug}`}
              className="inline-flex min-h-[44px] items-center rounded-md border border-border px-3 py-2 text-sm transition-colors hover:border-primary"
            >
              {m.viewPublicTeam}
            </Link>
          ) : undefined
        }
      />
      <p className="mb-6 -mt-2 text-sm text-muted-foreground">/{team.slug}</p>

      <h2 className="mb-3 text-sm font-semibold text-muted-foreground">
        {m.members} <span className="font-normal">({members.length})</span>
      </h2>
      <div className="mb-8">
        <TeamMembersPanel teamId={team.id} members={members} messages={m} locale={locale} />
      </div>

      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-muted-foreground">{m.teamEventTypes}</h2>
        {/* The only way to CREATE a team event — the list alone was a dead end
            (QA2 fix 5). */}
        <Link
          href={`/admin/event-types/new?teamId=${team.id}`}
          className="inline-flex min-h-[44px] items-center rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-transform active:scale-[0.98]"
        >
          {m.newTeamEvent}
        </Link>
      </div>
      <ul className="flex flex-col gap-2">
        {eventTypes.map((et) => (
          <li
            key={et.id}
            className="flex items-center justify-between gap-3 rounded-md border border-border bg-card p-4"
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
                messages={msgs.admin.eventTypes}
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
