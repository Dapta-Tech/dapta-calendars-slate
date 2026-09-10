import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { getMessages, t } from '@slate/shared';
import { MAX_AVAILABILITY_WINDOW_MS } from '@slate/types';
import { getAvailability, getProfile } from '@/lib/api';
import { publicLocale } from '@/lib/locale';
import { BookingFlow } from '@/components/booking-flow';
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

// Per-page SEO/OG from event + host data (R11 audit). getProfile is
// request-cached (shared with the page render); the event's public listing
// carries everything the tags need — no availability call here.
export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ accountCode: string; handle: string; slug: string }>;
  searchParams: Promise<RawSearchParams>;
}): Promise<Metadata> {
  const { accountCode, handle, slug } = await params;
  const query = await searchParams;
  const lang = typeof query.lang === 'string' ? query.lang : undefined;
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
    // An embedded URL is this same page with different chrome. Left indexable
    // it becomes a second copy of the host's booking page in search results,
    // reachable from any snippet's `src`.
    ...(isEmbedRequest(query) ? { robots: { index: false, follow: false } } : {}),
  };
}

// Public booking page. A Server Component fetches slots (free SEO + streaming);
// the interactive slot picker + form is a client island (BookingFlow).
export default async function BookingPage({
  params,
  searchParams,
}: {
  params: Promise<{ accountCode: string; handle: string; slug: string }>;
  searchParams: Promise<RawSearchParams>;
}) {
  const { accountCode, handle, slug } = await params;
  const query = await searchParams;
  const lang = typeof query.lang === 'string' ? query.lang : undefined;
  const locale = await publicLocale(lang);
  // Inline embed (E): the mode plus any appearance overrides the snippet
  // carries. Outside embed mode the overrides are empty by construction.
  const { embed, brandColor: accentOverride, style: styleOverrides } = parseEmbedParams(query);

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
    // The WHOLE query travels, not just `lang`. An alias-code URL in a pasted
    // snippet would otherwise 308 to a full-chrome page inside the frame, and
    // the embed would silently stop being an embed.
    permanentRedirect(withSearchParams(`/${code}/${handle}/${slug}`, query));
  }

  // The event's own description lives on the public listing, not on the
  // availability contract — the same row `generateMetadata` above already
  // reads, so the panel costs no extra call.
  const listing = profile.eventTypes.find((e) => e.slug === slug);
  const hostName = profile.member.displayName ?? profile.member.handle;

  return (
    <BrandedShell
      brandColor={accentOverride ?? profile.member.brandColor}
      style={mergeEmbedStyle(profile.member.style, styleOverrides)}
      className={embed ? EMBED_ROOT_CLASS : undefined}
    >
      {/* No link back to the profile page. `/{account}/{handle}` is its own
          entry point — the "Your booking link" the studio hands out — not the
          parent of every event page, and nothing here points at it. */}
      {/* Embed mode changes the padding and nothing else: the back-links this
          page used to carry went with BP, so there is no chrome left to strip. */}
      <main
        className={
          embed
            ? 'mx-auto max-w-6xl px-4 py-4'
            : 'mx-auto max-w-6xl px-4 py-10 sm:px-6 sm:py-12'
        }
      >
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
          embed={embed}
        />
      </main>
      {/* The badge stays inside the embed (#67): a host's own site is the
          growth loop's highest-value placement. NEXT_PUBLIC_HIDE_BADGE still
          removes it, so a bare fork carries no Dapta branding. */}
      <MadeWithBadge locale={locale} accountCode={accountCode} />
      {embed ? <EmbedResizeReporter /> : null}
    </BrandedShell>
  );
}
