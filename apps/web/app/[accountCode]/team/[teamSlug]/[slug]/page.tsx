import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { eventPageTitle, getMessages, schedulingMethodLabel, t } from '@slate/shared';
import { getTeamAvailability, getTeamProfile } from '@/lib/api';
import { failedChunk, toChunk, type AvailabilityChunk } from '@/lib/availability-source';
import { isBusy, orBusy } from '@/lib/busy';
import { BusyPage } from '@/components/busy-page';
import { firstWindow } from '@/lib/availability-window';
import { publicLocale } from '@/lib/locale';
import { BookingFlow } from '@/components/booking-flow';
import { BrandedShell } from '@/components/branded-shell';
import { logoOf, teamBranding } from '@/lib/brand-kit';
import { EmbedResizeReporter } from '@/components/embed-resize-reporter';
import { MadeWithBadge } from '@/components/made-with-badge';
import { VisitorAnalytics } from '@/components/analytics/visitor-analytics';
import { EventTracking } from '@/components/event-tracking';
import { analyticsConfig } from '@/lib/analytics/config';
import { brandingShown } from '@/lib/growth';
import {
  EMBED_ROOT_CLASS,
  isEmbedRequest,
  mergeEmbedStyle,
  parseEmbedParams,
  withSearchParams,
  type RawSearchParams,
} from '@/lib/embed';

// Per-page SEO/OG from team + event data (R11 audit); getTeamProfile is
// request-cached, so this shares the page's fetch.
export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ accountCode: string; teamSlug: string; slug: string }>;
  searchParams: Promise<RawSearchParams>;
}): Promise<Metadata> {
  const { accountCode, teamSlug, slug } = await params;
  const query = await searchParams;
  const team = await orBusy(getTeamProfile(accountCode, teamSlug));
  if (isBusy(team)) return { robots: { index: false, follow: false } };
  const event = team?.eventTypes.find((e) => e.slug === slug);
  if (!team || !event) return {};
  // The same title rule as a person's event page, with the team as the host,
  // matched on its whole name only: "The Growth Team" opens with a word that
  // half the event titles in the world contain.
  const growth = getMessages(await publicLocale()).growth;
  const title = eventPageTitle(growth.seoEventTitle, event.title, team.team.name, { firstName: false });
  const description =
    event.description ||
    t(growth.seoEvent, {
      event: event.title,
      name: team.team.name,
      minutes: event.lengthMinutes,
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

export default async function TeamBookingPage({
  params,
  searchParams,
}: {
  params: Promise<{ accountCode: string; teamSlug: string; slug: string }>;
  searchParams: Promise<RawSearchParams>;
}) {
  const { accountCode, teamSlug, slug } = await params;
  const query = await searchParams;
  const locale = await publicLocale();
  // Inline embed (E). A team event holds no stored branding of its own, so on
  // this route the URL overrides are the ONLY style there is — which is the
  // point: a host embedding a team event still gets to make it match their site.
  const { embed, brandColor: accentOverride, style: styleOverrides } = parseEmbedParams(query);
  const messages = getMessages(locale);
  const now = new Date();
  const from = now.toISOString();

  // The page paints from the team's public listing alone, exactly as the
  // personal route does; the visible month's availability streams in below.
  const read = await orBusy(getTeamProfile(accountCode, teamSlug));
  if (isBusy(read)) return <BusyPage locale={locale} retryAfterMs={read.retryAfterMs} />;
  const team = read;
  const listing = team?.eventTypes.find((e) => e.slug === slug);
  if (!team || !listing) notFound();

  // Canonical-code guard (short-links §4): alias URLs 308 to the canonical code.
  const code = team!.account.code;
  // The whole query travels, so an alias-code URL in a snippet stays an embed.
  if (accountCode !== code) {
    permanentRedirect(withSearchParams(`/${code}/team/${teamSlug}/${slug}`, query));
  }

  const kit = teamBranding(team.brand);
  // A team event's times are shown in the team's zone, as the availability
  // read answers them. The visible month is read without being awaited; see
  // the personal route. Which slots a team event offers is unchanged (#127).
  const timeZone = team.team.timeZone;
  const span = firstWindow(timeZone, now.getTime());
  const visible = {
    from: new Date(span.fromMs).toISOString(),
    to: new Date(span.toMs).toISOString(),
  };
  const initial: Promise<AvailabilityChunk> = getTeamAvailability({ accountCode, teamSlug, slug, ...visible }).then(
    toChunk,
    failedChunk,
  );

  return (
    <BrandedShell
      // A team stores no branding: it wears the workspace brand kit directly,
      // and the defaults when there is none (`teamBranding` is then null/null,
      // what this passed before there was a kit).
      brandColor={accentOverride ?? kit.brandColor}
      style={mergeEmbedStyle(kit.style, styleOverrides)}
      className={embed ? EMBED_ROOT_CLASS : 'bp-viewport'}
    >
      {/* No link back to the team page, for the same reason the personal event
          page no longer links to a profile: the team page is an entry point,
          not this page's parent. */}
      <main
        className={
          embed
            ? 'w-full py-4 md:px-4'
            : 'w-full py-10 md:px-6 md:py-12'
        }
      >
        <BookingFlow
          accountCode={accountCode}
          ownerSlug={teamSlug}
          slug={slug}
          mode="team"
          availability={{
            initial,
            window: visible,
            source: { kind: 'team', accountCode: code, owner: teamSlug, slug },
          }}
          initialTimeZone={timeZone}
          locale={locale}
          eventTitle={listing.title}
          lengthMinutes={listing.lengthMinutes}
          description={listing.description ?? null}
          // The team is the host here: its name and logo are what an invitee
          // is booking with, and B1's initial tile covers a team with no logo.
          hostName={team.team.name}
          avatarUrl={team.team.logoUrl}
          logoUrl={logoOf(kit.style)}
          location={listing.location ?? null}
          methodLabel={schedulingMethodLabel(messages, listing.schedulingType)}
          nowUtc={from}
          embed={embed}
          showBranding={brandingShown(team)}
        />
      </main>
      <MadeWithBadge locale={locale} accountCode={accountCode} show={brandingShown(team)} />
      {embed ? <EmbedResizeReporter /> : null}
      {/* Anonymous counts for the host's funnel, never the visitor's identity.
          Configured at request time; null (every bare fork) renders nothing. */}
      <VisitorAnalytics
        config={analyticsConfig()}
        page="team_event"
        accountKey={team.account.shortCode ?? null}
        embed={embed}
      />
      {/* The host's own tags for this event (GTM, Meta Pixel, their PostHog,
          HubSpot), apart from dCal's anonymous counts above. Nothing without ids. */}
      <EventTracking tracking={listing.tracking} />
    </BrandedShell>
  );
}
