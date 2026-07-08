import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getProfile } from '@/lib/api';

export default async function ProfilePage({
  params,
}: {
  params: Promise<{ accountCode: string; handle: string }>;
}) {
  const { accountCode, handle } = await params;
  const profile = await getProfile(accountCode, handle);
  if (!profile) notFound();

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <header className="mb-8 flex flex-col gap-1">
        <p className="text-sm text-muted-foreground">{profile.account.name}</p>
        <h1 className="text-3xl font-semibold tracking-tight">
          {profile.member.displayName ?? profile.member.handle}
        </h1>
        <p className="text-sm text-muted-foreground">
          Times in {profile.member.timeZone}
        </p>
      </header>

      <ul className="flex flex-col gap-3">
        {profile.eventTypes.map((et) => (
          <li key={et.slug}>
            <Link
              href={`/${accountCode}/${handle}/${et.slug}`}
              className="flex items-center justify-between rounded-md border border-border bg-card p-4 text-card-foreground transition-transform hover:border-primary active:scale-[0.99]"
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
        {profile.eventTypes.length === 0 ? (
          <li className="text-muted-foreground">No bookable events yet.</li>
        ) : null}
      </ul>
    </main>
  );
}
