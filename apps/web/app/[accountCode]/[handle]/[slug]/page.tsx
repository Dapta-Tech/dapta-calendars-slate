import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { getMessages, t } from '@slate/shared';
import { getAvailability, getProfile } from '@/lib/api';
import { toChunk, type AvailabilityChunk } from '@/lib/availability-source';
import { firstWindow } from '@/lib/availability-window';
import { publicLocale } from '@/lib/locale';
import { BookingFlow } from '@/components/booking-flow';
import { BrandedShell } from '@/components/branded-shell';
import { EmbedResizeReporter } from '@/components/embed-resize-reporter';
import { MadeWithBadge } from '@/components/made-with-badge';
import { resolveAvatarUrl, resolveOgImages } from '@/lib/avatar';
import { logoOf } from '@/lib/brand-kit';
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
  const images = resolveOgImages(profile.member.avatarUrl, profile.member.connectedAvatarUrl);
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

// Public booking page. The Server Component renders the event and its month
// from the profile alone and STARTS the visible month's availability read
// without waiting for it: the read streams into the client island
// (BookingFlow), which reads the later months itself as the visitor nears them.
// Nothing on the critical path talks to a calendar.
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

  const profile = await getProfile(accountCode, handle);
  // The public listing is the event's existence check: it holds every event
  // the availability route answers for on this URL (hidden ones are reached
  // only through `/booking/{token}`).
  const listing = profile?.eventTypes.find((e) => e.slug === slug);
  if (!profile || !listing) notFound();

  // Canonical-code guard (short-links §4): alias URLs 308 to the canonical code.
  const code = profile!.account.code;
  if (accountCode !== code) {
    // The WHOLE query travels, not just `lang`. An alias-code URL in a pasted
    // snippet would otherwise 308 to a full-chrome page inside the frame, and
    // the embed would silently stop being an embed.
    permanentRedirect(withSearchParams(`/${code}/${handle}/${slug}`, query));
  }

  const hostName = profile.member.displayName ?? profile.member.handle;
  // The zone the month is drawn in, resolved by the API the same way the
  // availability read resolves it, so the grid painted now is the grid the
  // times land in.
  const timeZone = listing.timeZone ?? profile.member.timeZone;

  // The visible month, from now to the end of the month on screen. Started
  // here, awaited by nobody on the server: it rides the response stream and
  // settles the grid when it lands. A failed read is an answer too (the island
  // says the times are unavailable), never a thrown page.
  const span = firstWindow(timeZone, now.getTime());
  const visible = {
    from: new Date(span.fromMs).toISOString(),
    to: new Date(span.toMs).toISOString(),
  };
  const initial: Promise<AvailabilityChunk> = getAvailability({ accountCode, handle, slug, ...visible }).then(
    toChunk,
    () => ({ ok: false }) as const,
  );

  return (
    <BrandedShell
      brandColor={accentOverride ?? profile.member.brandColor}
      style={mergeEmbedStyle(profile.member.style, styleOverrides)}
      className={embed ? EMBED_ROOT_CLASS : 'bp-viewport'}
    >
      {/* No link back to the profile page. `/{account}/{handle}` is its own
          entry point — the "Your booking link" the studio hands out — not the
          parent of every event page, and nothing here points at it. */}
      {/* Embed mode changes the padding and nothing else: the back-links this
          page used to carry went with BP, so there is no chrome left to strip. */}
      <main
        className={
          embed
            ? 'w-full py-4 md:px-4'
            : 'w-full py-10 md:px-6 md:py-12'
        }
      >
        <BookingFlow
          accountCode={accountCode}
          ownerSlug={handle}
          slug={slug}
          availability={{
            initial,
            window: visible,
            source: { kind: 'personal', accountCode: code, owner: handle, slug },
          }}
          initialTimeZone={timeZone}
          locale={locale}
          eventTitle={listing.title}
          lengthMinutes={listing.lengthMinutes}
          description={listing.description ?? null}
          hostName={hostName}
          avatarUrl={resolveAvatarUrl(profile.member.avatarUrl, profile.member.connectedAvatarUrl)}
          logoUrl={logoOf(profile.member.style)}
          location={listing.location ?? null}
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
