import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { getMessages, t } from '@slate/shared';
import { MAX_AVAILABILITY_WINDOW_MS } from '@slate/types';
import { getAvailability, getProfile } from '@/lib/api';
import { publicLocale } from '@/lib/locale';
import { BookingFlow } from '@/components/booking-flow';
import { BrandedShell } from '@/components/branded-shell';
import { MadeWithBadge } from '@/components/made-with-badge';

// Per-page SEO/OG from event + host data (R11 audit). getProfile is
// request-cached (shared with the page render); the event's public listing
// carries everything the tags need — no availability call here.
export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ accountCode: string; handle: string; slug: string }>;
  searchParams: Promise<{ lang?: string }>;
}): Promise<Metadata> {
  const { accountCode, handle, slug } = await params;
  const { lang } = await searchParams;
  const profile = await getProfile(accountCode, handle);
  const event = profile?.eventTypes.find((e) => e.slug === slug);
  if (!profile || !event) return {};
  const name = profile.member.displayName ?? profile.member.handle;
  const title = `${event.title} — ${name}`;
  const description =
    event.description ||
    t(getMessages(await publicLocale(lang)).growth.seoEvent, {
      event: event.title,
      name,
      minutes: event.lengthMinutes,
    });
  const avatar = profile.member.avatarUrl;
  const images = avatar && /^https?:\/\//i.test(avatar) ? [avatar] : undefined;
  return {
    title,
    description,
    openGraph: { title, description, type: 'website', images },
    twitter: { card: 'summary', title, description, images },
  };
}

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
  const locale = await publicLocale(lang);

  const now = new Date();
  const from = now.toISOString();
  // The widest single read the contract allows, not 21 days: the month calendar
  // (BP) needs a whole month per view, and the availability service clamps its
  // own window to this same bound (#136), so asking for more silently gets this
  // and asking for 21 left the calendar unable to fill its own grid.
  const to = new Date(now.getTime() + MAX_AVAILABILITY_WINDOW_MS).toISOString();

  const [profile, availability] = await Promise.all([
    getProfile(accountCode, handle),
    getAvailability({ accountCode, handle, slug, from, to }),
  ]);

  if (!profile || !availability) notFound();

  // Canonical-code guard (short-links §4): alias URLs 308 to the canonical code.
  const code = profile!.account.code;
  if (accountCode !== code) {
    permanentRedirect(`/${code}/${handle}/${slug}${lang ? `?lang=${lang}` : ''}`);
  }

  // The event's own description lives on the public listing, not on the
  // availability contract — the same row `generateMetadata` above already
  // reads, so the panel costs no extra call.
  const listing = profile.eventTypes.find((e) => e.slug === slug);
  const hostName = profile.member.displayName ?? profile.member.handle;

  return (
    <BrandedShell brandColor={profile.member.brandColor} style={profile.member.style}>
      {/* No link back to the profile page. `/{account}/{handle}` is its own
          entry point — the "Your booking link" the studio hands out — not the
          parent of every event page, and nothing here points at it. */}
      <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-12">
        <BookingFlow
          accountCode={accountCode}
          ownerSlug={handle}
          slug={slug}
          slots={availability.slots}
          emptyReason={availability.emptyReason}
          bookingFields={availability.eventType.bookingFields}
          initialTimeZone={availability.timeZone}
          locale={locale}
          eventTitle={availability.eventType.title}
          lengthMinutes={availability.eventType.lengthMinutes}
          description={listing?.description ?? null}
          hostName={hostName}
          avatarUrl={profile.member.avatarUrl}
          location={availability.eventType.location}
          nowUtc={from}
        />
      </main>
      <MadeWithBadge locale={locale} accountCode={accountCode} />
    </BrandedShell>
  );
}
