import Link from 'next/link';
import { getMessages } from '@slate/shared';
import { adminApi } from '@/lib/admin-api';
import { getLocale } from '@/lib/locale';
import { TeamCard } from './teams-client';

export const dynamic = 'force-dynamic';

export default async function TeamsPage() {
  const teams = await adminApi.listTeams();
  const withMembers = await Promise.all(
    teams.map(async (t) => ({ team: t, count: (await adminApi.teamMembers(t.id)).length })),
  );
  const m = getMessages(await getLocale()).admin.teams;

  return (
    <div className="mx-auto max-w-[1520px] px-8 py-10">
      <div className="mb-6 flex items-center justify-between gap-3">
        <div>
          <h1 className="mb-1 text-3xl font-semibold tracking-tight">{m.title}</h1>
          <p className="text-muted-foreground">{m.subtitle}</p>
        </div>
        <Link
          href="/admin/teams/new"
          className="inline-flex min-h-[44px] items-center rounded-md bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-transform active:scale-[0.98]"
        >
          {m.newTeam}
        </Link>
      </div>
      <div className="flex flex-col gap-3">
        {withMembers.map(({ team, count }) => (
          <TeamCard key={team.id} team={team} memberCount={count} messages={m} />
        ))}
        {teams.length === 0 ? (
          <p className="rounded-md border border-dashed border-border p-6 text-sm text-muted-foreground">
            {m.emptyList}
          </p>
        ) : null}
      </div>
    </div>
  );
}
