import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getAvailability, getProfile } from '@/lib/api';
import { BookingFlow } from '@/components/booking-flow';
import { BrandedShell } from '@/components/branded-shell';

// Public booking page. A Server Component fetches slots (free SEO + streaming);
// the interactive slot picker + form is a client island (BookingFlow).
export default async function BookingPage({
  params,
  searchParams,
}: {
  params: Promise<{ accountCode: string; handle: string; slug: string }>;
  searchParams: Promise<{ lang?: string }>;
}) {
  const { accountCode, handle, slug } = await params;
  const { lang } = await searchParams;
  const locale = lang?.startsWith('es') ? 'es' : 'en';

  const now = new Date();
  const from = now.toISOString();
  const to = new Date(now.getTime() + 21 * 86_400_000).toISOString();

  const [profile, availability] = await Promise.all([
    getProfile(accountCode, handle),
    getAvailability({ accountCode, handle, slug, from, to }),
  ]);

  if (!profile || !availability) notFound();

  return (
    <BrandedShell brandColor={profile.member.brandColor} style={profile.member.style}>
      <main className="mx-auto max-w-4xl px-6 py-12">
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
          ownerSlug={handle}
          slug={slug}
          slots={availability.slots}
          emptyReason={availability.emptyReason}
          bookingFields={availability.eventType.bookingFields}
          initialTimeZone={availability.timeZone}
          locale={locale}
        />
      </main>
    </BrandedShell>
  );
}
