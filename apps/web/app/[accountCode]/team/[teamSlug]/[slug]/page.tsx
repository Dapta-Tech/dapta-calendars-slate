import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { getMessages, schedulingMethodLabel, t } from '@slate/shared';
import { getTeamAvailability, getTeamProfile } from '@/lib/api';
import { publicLocale } from '@/lib/locale';
import { BookingFlow } from '@/components/booking-flow';
import { BrandedShell } from '@/components/branded-shell';
import { MadeWithBadge } from '@/components/made-with-badge';

// Per-page SEO/OG from team + event data (R11 audit); getTeamProfile is
// request-cached, so this shares the page's fetch.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ accountCode: string; teamSlug: string; slug: string }>;
}): Promise<Metadata> {
  const { accountCode, teamSlug, slug } = await params;
  const team = await getTeamProfile(accountCode, teamSlug);
  const event = team?.eventTypes.find((e) => e.slug === slug);
  if (!team || !event) return {};
  const title = `${event.title} — ${team.team.name}`;
  const description =
    event.description ||
    t(getMessages(await publicLocale()).growth.seoEvent, {
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
  };
}

export default async function TeamBookingPage({
  params,
}: {
  params: Promise<{ accountCode: string; teamSlug: string; slug: string }>;
}) {
  const { accountCode, teamSlug, slug } = await params;
  const locale = await publicLocale();
  const messages = getMessages(locale);
  const now = new Date();
  const from = now.toISOString();
  // 60 days — the month calendar's window, and the service's own clamp. Which
  // slots a team event offers is unchanged (#127 owns that question); this
  // only asks for more of the days it was already prepared to answer for.
  const to = new Date(now.getTime() + 60 * 86_400_000).toISOString();

  const [team, availability] = await Promise.all([
    getTeamProfile(accountCode, teamSlug),
    getTeamAvailability({ accountCode, teamSlug, slug, from, to }),
  ]);
  if (!team || !availability) notFound();

  // Canonical-code guard (short-links §4): alias URLs 308 to the canonical code.
  const code = team!.account.code;
  if (accountCode !== code) permanentRedirect(`/${code}/team/${teamSlug}/${slug}`);

  const listing = team.eventTypes.find((e) => e.slug === slug);

  return (
    <BrandedShell brandColor={null} style={null}>
      {/* No link back to the team page, for the same reason the personal event
          page no longer links to a profile: the team page is an entry point,
          not this page's parent. */}
      <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-12">
        <BookingFlow
          accountCode={accountCode}
          ownerSlug={teamSlug}
          slug={slug}
          mode="team"
          slots={availability.slots}
          emptyReason={availability.emptyReason}
          bookingFields={availability.eventType.bookingFields}
          initialTimeZone={availability.timeZone}
          locale={locale}
          eventTitle={availability.eventType.title}
          lengthMinutes={availability.eventType.lengthMinutes}
          description={listing?.description ?? null}
          // The team is the host here: its name and logo are what an invitee
          // is booking with, and B1's initial tile covers a team with no logo.
          hostName={team.team.name}
          avatarUrl={team.team.logoUrl}
          location={availability.eventType.location}
          methodLabel={schedulingMethodLabel(messages, availability.eventType.schedulingType)}
          nowUtc={from}
        />
      </main>
      <MadeWithBadge locale={locale} accountCode={accountCode} />
    </BrandedShell>
  );
}
