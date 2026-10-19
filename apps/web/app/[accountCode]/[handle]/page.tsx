import type { Metadata } from 'next';
import { notFound, permanentRedirect, redirect } from 'next/navigation';
import { getMessages, t } from '@slate/shared';
import { getProfile } from '@/lib/api';
import { publicLocale } from '@/lib/locale';
import { BrandedShell } from '@/components/branded-shell';
import { logoOf } from '@/lib/brand-kit';
import { EmbedResizeReporter } from '@/components/embed-resize-reporter';
import { MadeWithBadge } from '@/components/made-with-badge';
import { VisitorAnalytics } from '@/components/analytics/visitor-analytics';
import { analyticsConfig } from '@/lib/analytics/config';
import { ProfileView, profileEyebrow } from '@/components/profile-view';
import { resolveAvatarUrl } from '@/lib/avatar';
import { landingTarget, wantsProfile } from '@/lib/landing';
import { brandingShown, signupHref } from '@/lib/growth';
import { GrowthCta } from '@/components/booking-page-parts';
import {
  EMBED_ROOT_CLASS,
  isEmbedRequest,
  mergeEmbedStyle,
  parseEmbedParams,
  withSearchParams,
  type RawSearchParams,
} from '@/lib/embed';

// Per-page SEO/OG from host data (R11 audit). getProfile is request-cached, so
// this shares the page's fetch. Only public profile fields are used. The image
// is `opengraph-image.tsx` beside this file (the host's own card), so no
// `images` here: an explicit list would replace it.
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
  // The card's headline is the name; the account rides along only when it says
  // something the name does not, by the same rule as the line over the name on
  // the page (`profileEyebrow`), so the tab never says a name twice either.
  const account = profileEyebrow(profile.account.name, name);
  const title = account ? `${name} · ${account}` : name;
  return {
    title,
    description,
    openGraph: { title, description, type: 'profile' },
    twitter: { card: 'summary_large_image', title, description },
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
  const msg = getMessages(locale);
  // Inline embed (E): the mode plus any appearance overrides the snippet
  // carries. Empty by construction outside embed mode.
  const { embed, brandColor: accentOverride, style: styleOverrides } = parseEmbedParams(query);

  // Canonical-code guard (short-links §4): the API resolves legacy/alias codes
  // but responds with the CANONICAL code — a visit on an alias 308s to it, so
  // old shared links keep working and search engines converge on one URL.
  const code = profile!.account.code;
  if (accountCode !== code) permanentRedirect(withSearchParams(`/${code}/${handle}`, query));

  const m = profile.member;

  // Where the link goes (lib/landing.ts, the studio says the same thing): the
  // event the host chose, or their only event, else this profile. `?landing=1`
  // always shows the profile.
  const target = landingTarget({
    style: m.style as Record<string, unknown> | null,
    eventSlugs: profile.eventTypes.map((e) => e.slug),
    forceProfile: wantsProfile(query),
  });
  if (target.kind === 'event') {
    // Carries the query, so an embedded landing link still serves an embed
    // rather than a full-chrome event page inside the frame.
    redirect(withSearchParams(`/${code}/${handle}/${target.slug}`, query));
  }
  // The style the shell below renders with, derived ONCE: the canvas and every
  // axis come out of it, and the embed's overrides are already merged in.
  const style = mergeEmbedStyle(m.style, styleOverrides);
  const headerAvatar = resolveAvatarUrl(m.avatarUrl, m.connectedAvatarUrl);
  const bio = (m.style as { bio?: string } | null)?.bio ?? null;
  const name = m.displayName ?? m.handle;

  // Honor the host's chosen event order (studio Meetings panel); unlisted last.
  const order = (m.style as { eventOrder?: string[] } | null)?.eventOrder ?? [];
  const rank = (slug: string) => {
    const i = order.indexOf(slug);
    return i === -1 ? order.length + 1 : i;
  };
  const eventTypes = [...profile.eventTypes].sort((a, b) => rank(a.slug) - rank(b.slug));
  // A host's verdict: a way to make your own page, at the foot of theirs.
  const branding = brandingShown(profile);
  const profileCta = signupHref('profile', code, branding);

  return (
    <BrandedShell
      brandColor={accentOverride ?? m.brandColor}
      style={style}
      className={embed ? EMBED_ROOT_CLASS : 'bp-viewport'}
    >
      <main className={embed ? 'mx-auto max-w-2xl px-4 py-4' : 'mx-auto w-full max-w-2xl px-6 py-12'}>
        <ProfileView
          m={msg}
          name={name}
          context={profile.account.name}
          bio={bio}
          avatarUrl={headerAvatar}
          coverUrl={m.coverUrl}
          events={eventTypes}
          // Inside a frame this navigates the frame, which is the embed working,
          // but only if the mode and the overrides travel with it. Without them,
          // picking an event from a styled embed lands on an unstyled full-chrome
          // page in a 700px box.
          hrefFor={(slug) => withSearchParams(`/${code}/${handle}/${slug}`, query)}
          emptyText={msg.landing.noEvents}
          logoUrl={logoOf(m.style)}
          footer={profileCta ? <GrowthCta m={msg} href={profileCta} /> : null}
        />
      </main>
      <MadeWithBadge locale={locale} accountCode={accountCode} show={branding} />
      {embed ? <EmbedResizeReporter /> : null}
      {/* Anonymous counts for the host's funnel, never the visitor's identity.
          Configured at request time; null (every bare fork) renders nothing. */}
      <VisitorAnalytics
        config={analyticsConfig()}
        page="profile"
        accountKey={profile.account.shortCode ?? null}
        embed={embed}
      />
    </BrandedShell>
  );
}
