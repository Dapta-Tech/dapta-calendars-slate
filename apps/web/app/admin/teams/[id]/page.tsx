import Link from 'next/link';
import { notFound } from 'next/navigation';
import { adminApi } from '@/lib/admin-api';
import { TeamCard } from '../teams-client';

export const dynamic = 'force-dynamic';

export default async function TeamDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [me, teams, accountMembers] = await Promise.all([
    adminApi.me().catch(() => null),
    adminApi.listTeams().catch(() => []),
    adminApi.listMembers().catch(() => []),
  ]);
  const team = teams.find((t) => t.id === id);
  if (!team) notFound();
  const [members, eventTypes] = await Promise.all([
    adminApi.teamMembers(id).catch(() => []),
    adminApi.teamEventTypes(id).catch(() => []),
  ]);

  return (
    <div className="mx-auto max-w-3xl px-8 py-10">
      <Link href="/admin/teams" className="text-sm text-muted-foreground hover:text-foreground">
        ← Teams
      </Link>
      <div className="mb-6 mt-2 flex items-center justify-between">
        <h1 className="text-3xl font-semibold tracking-tight">{team.name}</h1>
        {me?.accountCode && team.slug ? (
          <Link href={`/${me.accountCode}/team/${team.slug}`} className="text-sm text-primary hover:underline">
            View public team page →
          </Link>
        ) : null}
      </div>

      <h2 className="mb-3 text-sm font-semibold text-muted-foreground">Members</h2>
      <div className="mb-8">
        <TeamCard team={team} members={members} accountMembers={accountMembers} />
      </div>

      <h2 className="mb-3 text-sm font-semibold text-muted-foreground">Team event types</h2>
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
          <li className="text-sm text-muted-foreground">No team event types yet.</li>
        ) : null}
      </ul>
    </div>
  );
}
