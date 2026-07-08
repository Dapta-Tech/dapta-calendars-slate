import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTeamProfile } from '@/lib/api';

export default async function TeamPage({
  params,
}: {
  params: Promise<{ accountCode: string; teamSlug: string }>;
}) {
  const { accountCode, teamSlug } = await params;
  const team = await getTeamProfile(accountCode, teamSlug);
  if (!team) notFound();

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <header className="mb-8 flex flex-col gap-1">
        <p className="text-sm text-muted-foreground">{team.account.name}</p>
        <h1 className="text-3xl font-semibold tracking-tight">{team.team.name}</h1>
        <p className="text-sm text-muted-foreground">Times in {team.team.timeZone}</p>
      </header>

      <ul className="flex flex-col gap-3">
        {team.eventTypes.map((et) => (
          <li key={et.slug}>
            <Link
              href={`/${accountCode}/team/${teamSlug}/${et.slug}`}
              className="flex items-center justify-between rounded-md border border-border bg-card p-4 transition-transform hover:border-primary active:scale-[0.99]"
            >
              <span className="flex flex-col">
                <span className="font-medium">{et.title}</span>
                {et.description ? (
                  <span className="text-sm text-muted-foreground">{et.description}</span>
                ) : null}
              </span>
              <span className="rounded-sm bg-muted px-2 py-1 text-sm text-muted-foreground">
                {et.lengthMinutes} min
              </span>
            </Link>
          </li>
        ))}
        {team.eventTypes.length === 0 ? (
          <li className="text-muted-foreground">No bookable team events yet.</li>
        ) : null}
      </ul>
    </main>
  );
}
