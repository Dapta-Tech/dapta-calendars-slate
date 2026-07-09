import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
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

  // R25 optional landing (G6): when the host disabled the landing page and set a
  // default event, jump straight to that event's booking page.
  const landing = m.style as { landingEnabled?: boolean; defaultEventSlug?: string | null } | null;
  const defaultSlug = landing?.defaultEventSlug;
  if (landing?.landingEnabled === false && defaultSlug && profile.eventTypes.some((e) => e.slug === defaultSlug)) {
    redirect(`/${accountCode}/${handle}/${defaultSlug}`);
  }
  const accent = clampAccent(m.brandColor ?? '#cbe84f');
  const bio = (m.style as { bio?: string } | null)?.bio ?? null;
  const name = m.displayName ?? m.handle;

  // Honor the host's chosen event order (studio Meetings panel); unlisted last.
  const order = (m.style as { eventOrder?: string[] } | null)?.eventOrder ?? [];
  const rank = (slug: string) => {
    const i = order.indexOf(slug);
    return i === -1 ? order.length + 1 : i;
  };
  const eventTypes = [...profile.eventTypes].sort((a, b) => rank(a.slug) - rank(b.slug));

  return (
    <BrandedShell brandColor={m.brandColor} style={m.style}>
      <main className="mx-auto max-w-2xl px-6 py-12">
        {m.coverUrl ? (
          <img src={m.coverUrl} alt="" className="bp-cover mb-4 h-32 w-full rounded-md object-cover" />
        ) : (
          <div className="bp-cover mb-4 h-24 w-full rounded-md" style={{ background: 'var(--accent-wash)' }} />
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
          {eventTypes.map((et) => (
            <li key={et.slug}>
              <Link
                href={`/${accountCode}/${handle}/${et.slug}`}
                className="bp-card flex items-center justify-between text-card-foreground transition-transform hover:border-primary active:scale-[0.99]"
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
          {eventTypes.length === 0 ? (
            <li className="text-muted-foreground">No bookable events yet.</li>
          ) : null}
        </ul>
      </main>
    </BrandedShell>
  );
}
