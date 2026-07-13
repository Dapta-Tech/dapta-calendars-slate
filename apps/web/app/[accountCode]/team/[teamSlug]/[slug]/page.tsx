import { notFound, permanentRedirect } from 'next/navigation';
import { headers } from 'next/headers';
import Link from 'next/link';
import { getMessages, schedulingMethodLabel } from '@slate/shared';
import { getTeamAvailability, getTeamProfile } from '@/lib/api';
import { BookingFlow } from '@/components/booking-flow';
import { BrandedShell } from '@/components/branded-shell';

export default async function TeamBookingPage({
  params,
}: {
  params: Promise<{ accountCode: string; teamSlug: string; slug: string }>;
}) {
  const { accountCode, teamSlug, slug } = await params;
  const lang = (await headers()).get('accept-language') ?? '';
  const messages = getMessages(lang.startsWith('es') ? 'es' : 'en');
  const now = new Date();
  const from = now.toISOString();
  const to = new Date(now.getTime() + 21 * 86_400_000).toISOString();

  const [team, availability] = await Promise.all([
    getTeamProfile(accountCode, teamSlug),
    getTeamAvailability({ accountCode, teamSlug, slug, from, to }),
  ]);
  if (!team || !availability) notFound();

  // Canonical-code guard (short-links §4): alias URLs 308 to the canonical code.
  const code = team!.account.code;
  if (accountCode !== code) permanentRedirect(`/${code}/team/${teamSlug}/${slug}`);

  return (
    <BrandedShell brandColor={null} style={null}>
      <main className="mx-auto max-w-3xl px-6 py-12">
        <header className="mb-8 flex flex-col gap-1">
          <Link href={`/${code}/team/${teamSlug}`} className="text-sm text-muted-foreground hover:text-foreground">
            ← {team.team.name}
          </Link>
          <h1 className="text-3xl font-semibold tracking-tight">{availability.eventType.title}</h1>
          <p className="text-sm text-muted-foreground">
            {availability.eventType.lengthMinutes} min · {team.team.name} ·{' '}
            {schedulingMethodLabel(messages, availability.eventType.schedulingType)}
          </p>
        </header>

        <BookingFlow
          accountCode={accountCode}
          ownerSlug={teamSlug}
          slug={slug}
          mode="team"
          slots={availability.slots}
          emptyReason={availability.emptyReason}
          bookingFields={availability.eventType.bookingFields}
          initialTimeZone={availability.timeZone}
        />
      </main>
    </BrandedShell>
  );
}
