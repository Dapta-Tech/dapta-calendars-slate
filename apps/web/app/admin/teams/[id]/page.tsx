import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getMessages } from '@slate/shared';
import { adminApi } from '@/lib/admin-api';
import { getLocale } from '@/lib/locale';
import { TeamMembersPanel } from '../team-members-panel';

export const dynamic = 'force-dynamic';

export default async function TeamDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [me, teams, accountMembers] = await Promise.all([
    adminApi.me(),
    adminApi.listTeams(),
    adminApi.listMembers(),
  ]);
  const team = teams.find((t) => t.id === id);
  if (!team) notFound();
  const [members, eventTypes] = await Promise.all([
    adminApi.teamMembers(id),
    adminApi.teamEventTypes(id),
  ]);
  const m = getMessages(await getLocale()).admin.teams;

  return (
    <div className="mx-auto max-w-[1520px] px-8 py-10">
      <Link href="/admin/teams" className="text-sm text-muted-foreground hover:text-foreground">
        {m.backToTeams}
      </Link>
      <div className="mb-1 mt-2 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">{team.name}</h1>
        {me?.accountCode && team.slug ? (
          <Link href={`/${me.accountCode}/team/${team.slug}`} className="text-sm text-primary hover:underline">
            {m.viewPublicTeam}
          </Link>
        ) : null}
      </div>
      <p className="mb-6 text-sm text-muted-foreground">/{team.slug} · {m.roundRobin}</p>

      <h2 className="mb-3 text-sm font-semibold text-muted-foreground">
        {m.members} <span className="font-normal">({members.length})</span>
      </h2>
      <div className="mb-8">
        <TeamMembersPanel teamId={team.id} members={members} accountMembers={accountMembers} messages={m} />
      </div>

      <h2 className="mb-3 text-sm font-semibold text-muted-foreground">{m.teamEventTypes}</h2>
      <ul className="flex flex-col gap-2">
        {eventTypes.map((et) => (
          <li key={et.id} className="flex items-center justify-between rounded-md border border-border bg-card p-4">
            <span className="flex flex-col">
              <span className="font-medium">{et.title}</span>
              <span className="text-sm text-muted-foreground">
                /{et.slug} · {et.lengthMinutes} min · {et.schedulingType ?? 'personal'}
              </span>
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
