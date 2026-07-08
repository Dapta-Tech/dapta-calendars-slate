import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getAvailability, getProfile } from '@/lib/api';
import { BookingFlow } from '@/components/booking-flow';

// Public booking page. A Server Component fetches slots (free SEO + streaming);
// the interactive slot picker + form is a client island (BookingFlow).
export default async function BookingPage({
  params,
}: {
  params: Promise<{ accountCode: string; handle: string; slug: string }>;
}) {
  const { accountCode, handle, slug } = await params;

  const now = new Date();
  const from = now.toISOString();
  const to = new Date(now.getTime() + 14 * 86_400_000).toISOString();

  const [profile, availability] = await Promise.all([
    getProfile(accountCode, handle),
    getAvailability({ accountCode, handle, slug, from, to }),
  ]);

  if (!profile || !availability) notFound();

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <header className="mb-8 flex flex-col gap-1">
        <Link
          href={`/${accountCode}/${handle}`}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← {profile.member.displayName ?? profile.member.handle}
        </Link>
        <h1 className="text-3xl font-semibold tracking-tight">{availability.eventType.title}</h1>
        <p className="text-sm text-muted-foreground">
          {availability.eventType.lengthMinutes} min · with{' '}
          {profile.member.displayName ?? profile.member.handle}
        </p>
      </header>

      <BookingFlow
        accountCode={accountCode}
        handle={handle}
        slug={slug}
        slots={availability.slots}
        initialTimeZone={availability.timeZone}
      />
    </main>
  );
}
