import Link from 'next/link';
import { notFound } from 'next/navigation';
import { clampAccent, monogram, onAccent } from '@slate/shared';
import { getProfile } from '@/lib/api';
import { BrandedShell } from '@/components/branded-shell';

export default async function ProfilePage({
  params,
}: {
  params: Promise<{ accountCode: string; handle: string }>;
}) {
  const { accountCode, handle } = await params;
  const profile = await getProfile(accountCode, handle);
  if (!profile) notFound();

  const m = profile.member;
  const accent = clampAccent(m.brandColor ?? '#cbe84f');
  const bio = (m.style as { bio?: string } | null)?.bio ?? null;
  const name = m.displayName ?? m.handle;

  return (
    <BrandedShell brandColor={m.brandColor} style={m.style}>
      <main className="mx-auto max-w-2xl px-6 py-12">
        {m.coverUrl ? (
          <img src={m.coverUrl} alt="" className="mb-4 h-32 w-full rounded-md object-cover" />
        ) : (
          <div className="mb-4 h-24 w-full rounded-md" style={{ background: 'var(--accent-wash)' }} />
        )}
        <header className="mb-8 flex items-center gap-4">
          {m.avatarUrl ? (
            <img src={m.avatarUrl} alt="" className="h-16 w-16 rounded-full object-cover" />
          ) : (
            <div
              className="flex h-16 w-16 items-center justify-center text-2xl font-semibold"
              style={{ background: accent, color: onAccent(accent), borderRadius: 'var(--bp-radius, 0.75rem)' }}
            >
              {monogram(name)}
            </div>
          )}
          <div className="flex flex-col gap-0.5">
            <p className="text-sm text-muted-foreground">{profile.account.name}</p>
            <h1 className="text-3xl font-semibold tracking-tight">{name}</h1>
            {bio ? <p className="text-sm text-muted-foreground">{bio}</p> : null}
          </div>
        </header>

        <ul className="flex flex-col gap-3">
          {profile.eventTypes.map((et) => (
            <li key={et.slug}>
              <Link
                href={`/${accountCode}/${handle}/${et.slug}`}
                style={{ borderRadius: 'var(--bp-radius, 0.5rem)' }}
                className="flex items-center justify-between border border-border bg-card p-4 text-card-foreground transition-transform hover:border-primary active:scale-[0.99]"
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
    </BrandedShell>
  );
}
