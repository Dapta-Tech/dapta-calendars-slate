import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getTeamAvailability, getTeamProfile } from '@/lib/api';
import { BookingFlow } from '@/components/booking-flow';

export default async function TeamBookingPage({
  params,
}: {
  params: Promise<{ accountCode: string; teamSlug: string; slug: string }>;
}) {
  const { accountCode, teamSlug, slug } = await params;
  const now = new Date();
  const from = now.toISOString();
  const to = new Date(now.getTime() + 14 * 86_400_000).toISOString();

  const [team, availability] = await Promise.all([
    getTeamProfile(accountCode, teamSlug),
    getTeamAvailability({ accountCode, teamSlug, slug, from, to }),
  ]);
  if (!team || !availability) notFound();

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <header className="mb-8 flex flex-col gap-1">
        <Link href={`/${accountCode}/team/${teamSlug}`} className="text-sm text-muted-foreground hover:text-foreground">
          ← {team.team.name}
        </Link>
        <h1 className="text-3xl font-semibold tracking-tight">{availability.eventType.title}</h1>
        <p className="text-sm text-muted-foreground">
          {availability.eventType.lengthMinutes} min · {team.team.name} (round-robin)
        </p>
      </header>

      <BookingFlow
        accountCode={accountCode}
        ownerSlug={teamSlug}
        slug={slug}
        mode="team"
        slots={availability.slots}
        bookingFields={availability.eventType.bookingFields}
        initialTimeZone={availability.timeZone}
      />
    </main>
  );
}
