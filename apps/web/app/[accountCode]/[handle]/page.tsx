import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, permanentRedirect, redirect } from 'next/navigation';
import { DEFAULT_ACCENT, clampAccent, getMessages, monogram, onAccent, t } from '@slate/shared';
import { getProfile } from '@/lib/api';
import { publicLocale } from '@/lib/locale';
import { BOOKING_CANVAS } from '@/lib/booking-canvas';
import { BrandedShell } from '@/components/branded-shell';
import { EmbedResizeReporter } from '@/components/embed-resize-reporter';
import { MadeWithBadge } from '@/components/made-with-badge';
import {
  EMBED_ROOT_CLASS,
  isEmbedRequest,
  mergeEmbedStyle,
  parseEmbedParams,
  withSearchParams,
  type RawSearchParams,
} from '@/lib/embed';

// Per-page SEO/OG from host data (R11 audit). getProfile is request-cached, so
// this shares the page's fetch. Only public profile fields are used.
export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ accountCode: string; handle: string }>;
  searchParams: Promise<RawSearchParams>;
}): Promise<Metadata> {
  const { accountCode, handle } = await params;
  const query = await searchParams;
  const profile = await getProfile(accountCode, handle);
  if (!profile) return {};
  const name = profile.member.displayName ?? profile.member.handle;
  const bio = (profile.member.style as { bio?: string } | null)?.bio;
  const description = bio || t(getMessages(await publicLocale()).growth.seoProfile, { name });
  const title = `${name} — ${profile.account.name}`;
  const avatar = profile.member.avatarUrl;
  const images = avatar && /^https?:\/\//i.test(avatar) ? [avatar] : undefined;
  return {
    title,
    description,
    openGraph: { title, description, type: 'profile', images },
    twitter: { card: 'summary', title, description, images },
    // An embedded URL is this same page with different chrome — never a second
    // indexable copy of it.
    ...(isEmbedRequest(query) ? { robots: { index: false, follow: false } } : {}),
  };
}

export default async function ProfilePage({
  params,
  searchParams,
}: {
  params: Promise<{ accountCode: string; handle: string }>;
  searchParams: Promise<RawSearchParams>;
}) {
  const { accountCode, handle } = await params;
  const query = await searchParams;
  const [profile, locale] = await Promise.all([getProfile(accountCode, handle), publicLocale()]);
  if (!profile) notFound();
  // Inline embed (E): the mode plus any appearance overrides the snippet
  // carries. Empty by construction outside embed mode.
  const { embed, brandColor: accentOverride, style: styleOverrides } = parseEmbedParams(query);

  // Canonical-code guard (short-links §4): the API resolves legacy/alias codes
  // but responds with the CANONICAL code — a visit on an alias 308s to it, so
  // old shared links keep working and search engines converge on one URL.
  const code = profile!.account.code;
  if (accountCode !== code) permanentRedirect(withSearchParams(`/${code}/${handle}`, query));

  const m = profile.member;

  // R25 optional landing (G6): when the host disabled the landing page and set a
  // default event, jump straight to that event's booking page.
  const landing = m.style as { landingEnabled?: boolean; defaultEventSlug?: string | null } | null;
  const defaultSlug = landing?.defaultEventSlug;
  if (landing?.landingEnabled === false && defaultSlug && profile.eventTypes.some((e) => e.slug === defaultSlug)) {
    // Carries the query, so a host who embedded their landing link and then
    // turned the landing page off still serves an embed rather than a
    // full-chrome event page inside the frame.
    redirect(withSearchParams(`/${code}/${handle}/${defaultSlug}`, query));
  }
  // Same canvas the shell below clamps against — the monogram tile sits inside
  // it, so a second, differently-grounded clamp here would paint a tile that
  // does not match the accent everything around it resolved to.
  const accent = clampAccent(accentOverride ?? m.brandColor ?? DEFAULT_ACCENT, BOOKING_CANVAS);
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
    <BrandedShell
      brandColor={accentOverride ?? m.brandColor}
      style={mergeEmbedStyle(m.style, styleOverrides)}
      className={embed ? EMBED_ROOT_CLASS : undefined}
    >
      <main className={embed ? 'mx-auto max-w-2xl px-4 py-4' : 'mx-auto max-w-2xl px-6 py-12'}>
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
                // Inside a frame this navigates the frame, which is the embed
                // working — but only if the mode and the overrides travel with
                // it. Without them, picking an event from a styled embed lands
                // on an unstyled full-chrome page in a 700px box.
                href={withSearchParams(`/${code}/${handle}/${et.slug}`, query)}
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
      <MadeWithBadge locale={locale} accountCode={accountCode} />
      {embed ? <EmbedResizeReporter /> : null}
    </BrandedShell>
  );
}
