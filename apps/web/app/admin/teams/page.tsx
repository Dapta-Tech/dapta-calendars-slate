import { adminApi } from '@/lib/admin-api';
import { NewTeamForm, TeamCard } from './teams-client';

export const dynamic = 'force-dynamic';

export default async function TeamsPage() {
  const [teams, accountMembers] = await Promise.all([
    adminApi.listTeams().catch(() => []),
    adminApi.listMembers().catch(() => []),
  ]);
  const withMembers = await Promise.all(
    teams.map(async (t) => ({ team: t, members: await adminApi.teamMembers(t.id).catch(() => []) })),
  );

  return (
    <div className="mx-auto max-w-4xl px-8 py-10">
      <h1 className="mb-6 text-3xl font-semibold tracking-tight">Teams</h1>
      <div className="mb-8 flex flex-col gap-3">
        {withMembers.map(({ team, members }) => (
          <TeamCard key={team.id} team={team} members={members} accountMembers={accountMembers} />
        ))}
        {teams.length === 0 ? <p className="text-sm text-muted-foreground">No teams yet.</p> : null}
      </div>
      <h2 className="mb-3 text-sm font-semibold text-muted-foreground">New team</h2>
      <NewTeamForm />
    </div>
  );
}
