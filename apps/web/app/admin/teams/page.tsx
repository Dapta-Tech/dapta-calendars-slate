import { adminApi } from '@/lib/admin-api';
import { NewTeamForm, TeamCard } from './teams-client';

export const dynamic = 'force-dynamic';

export default async function TeamsPage() {
  const teams = await adminApi.listTeams();
  const withMembers = await Promise.all(
    teams.map(async (t) => ({ team: t, count: (await adminApi.teamMembers(t.id)).length })),
  );

  return (
    <div className="mx-auto max-w-[1520px] px-8 py-10">
      <h1 className="mb-1 text-3xl font-semibold tracking-tight">Teams</h1>
      <p className="mb-6 text-muted-foreground">Round-robin scheduling across a group of hosts.</p>
      <div className="mb-8 flex flex-col gap-3">
        {withMembers.map(({ team, count }) => (
          <TeamCard key={team.id} team={team} memberCount={count} />
        ))}
        {teams.length === 0 ? (
          <p className="rounded-md border border-dashed border-border p-6 text-sm text-muted-foreground">
            No teams yet — create one below to round-robin bookings across hosts.
          </p>
        ) : null}
      </div>
      <h2 className="mb-3 text-sm font-semibold text-muted-foreground">New team</h2>
      <NewTeamForm />
    </div>
  );
}
