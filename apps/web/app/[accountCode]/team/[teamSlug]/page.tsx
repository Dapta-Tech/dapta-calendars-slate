import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { getMessages, readableZone, t } from '@slate/shared';
import { getTeamProfile } from '@/lib/api';
import { publicLocale } from '@/lib/locale';
import { BrandedShell } from '@/components/branded-shell';
import { logoOf, teamBranding } from '@/lib/brand-kit';
import { EmbedResizeReporter } from '@/components/embed-resize-reporter';
import { MadeWithBadge } from '@/components/made-with-badge';
import { VisitorAnalytics } from '@/components/analytics/visitor-analytics';
import { analyticsConfig } from '@/lib/analytics/config';
import { ProfileView, profileEyebrow } from '@/components/profile-view';
import { GrowthCta } from '@/components/booking-page-parts';
import { brandingShown, signupHref } from '@/lib/growth';
import {
  EMBED_ROOT_CLASS,
  isEmbedRequest,
  mergeEmbedStyle,
  parseEmbedParams,
  withSearchParams,
  type RawSearchParams,
} from '@/lib/embed';

// Per-page SEO/OG from team data (R11 audit); getTeamProfile is request-cached.
export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ accountCode: string; teamSlug: string }>;
  searchParams: Promise<RawSearchParams>;
}): Promise<Metadata> {
  const { accountCode, teamSlug } = await params;
  const query = await searchParams;
  const team = await getTeamProfile(accountCode, teamSlug);
  if (!team) return {};
  // The workspace rides along only when it says something the team's name does
  // not (`profileEyebrow`, the rule for the line over the name on the page), and
  // with the separator the person profile's title uses.
  const account = profileEyebrow(team.account.name, team.team.name);
  const title = account ? `${team.team.name} · ${account}` : team.team.name;
  const description = t(getMessages(await publicLocale()).growth.seoProfile, {
    name: team.team.name,
  });
  const logo = team.team.logoUrl;
  const images = logo && /^https?:\/\//i.test(logo) ? [logo] : undefined;
  return {
    title,
    description,
    openGraph: { title, description, type: 'website', images },
    twitter: { card: 'summary', title, description, images },
    // An embedded URL is this same page with different chrome — never a second
    // indexable copy of it.
    ...(isEmbedRequest(query) ? { robots: { index: false, follow: false } } : {}),
  };
}

export default async function TeamPage({
  params,
  searchParams,
}: {
  params: Promise<{ accountCode: string; teamSlug: string }>;
  searchParams: Promise<RawSearchParams>;
}) {
  const { accountCode, teamSlug } = await params;
  const query = await searchParams;
  const [team, locale] = await Promise.all([getTeamProfile(accountCode, teamSlug), publicLocale()]);
  if (!team) notFound();
  const msg = getMessages(locale);

  // Canonical-code guard (short-links §4): alias URLs 308 to the canonical code.
  const code = team!.account.code;
  if (accountCode !== code) permanentRedirect(withSearchParams(`/${code}/team/${teamSlug}`, query));

  // Inline embed (E): the mode plus any appearance overrides the snippet
  // carries. A team stores no brandColor or style in the model, so the page
  // renders the defaults (the console and the lime, ADR 0004) unless an embed
  // snippet overrides them, through the same shell every other public page uses.
  const { embed, brandColor: accentOverride, style: styleOverrides } = parseEmbedParams(query);
  const kit = teamBranding(team.brand);

  const branding = brandingShown(team);
  const teamCta = signupHref('profile', code, branding);

  return (
    <BrandedShell
      // A team stores no branding: it wears the workspace brand kit directly,
      // and the defaults when there is none (`teamBranding` is then null/null,
      // what this passed before there was a kit).
      brandColor={accentOverride ?? kit.brandColor}
      style={mergeEmbedStyle(kit.style, styleOverrides)}
      className={embed ? EMBED_ROOT_CLASS : 'bp-viewport'}
    >
      <main className={embed ? 'mx-auto max-w-2xl px-4 py-4' : 'mx-auto w-full max-w-2xl px-6 py-12'}>
        <ProfileView
          m={msg}
          name={team.team.name}
          context={team.account.name}
          bio={t(msg.landing.timesIn, { timeZone: readableZone(team.team.timeZone) })}
          avatarUrl={team.team.logoUrl}
          events={team.eventTypes}
          // The mode and the overrides travel with an in-frame navigation, or
          // picking an event from a styled embed lands on an unstyled
          // full-chrome page inside the frame.
          hrefFor={(slug: string) => withSearchParams(`/${code}/team/${teamSlug}/${slug}`, query)}
          emptyText={msg.landing.noTeamEvents}
          logoUrl={logoOf(kit.style)}
          footer={teamCta ? <GrowthCta m={msg} href={teamCta} /> : null}
        />
      </main>
      <MadeWithBadge locale={locale} accountCode={code} show={branding} />
      {embed ? <EmbedResizeReporter /> : null}
      {/* Anonymous counts for the host's funnel, never the visitor's identity.
          Configured at request time; null (every bare fork) renders nothing. */}
      <VisitorAnalytics
        config={analyticsConfig()}
        page="team"
        accountKey={team.account.shortCode ?? null}
        embed={embed}
      />
    </BrandedShell>
  );
}
