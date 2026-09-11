import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getMessages, schedulingMethodLabel } from '@slate/shared';
import { MAX_AVAILABILITY_WINDOW_MS } from '@slate/types';
import {
  getAvailabilityWithOneOff,
  getOneOffLink,
  getProfile,
  getTeamAvailabilityWithOneOff,
  getTeamProfile,
} from '@/lib/api';
import { publicLocale } from '@/lib/locale';
import { BookingFlow } from '@/components/booking-flow';
import { BrandedShell } from '@/components/branded-shell';
import { EmbedResizeReporter } from '@/components/embed-resize-reporter';
import { MadeWithBadge } from '@/components/made-with-badge';
import { resolveAvatarUrl } from '@/lib/avatar';
import {
  EMBED_ROOT_CLASS,
  mergeEmbedStyle,
  parseEmbedParams,
  type RawSearchParams,
} from '@/lib/embed';

/**
 * One-off invite links (#69 / AB2, #110) — `/booking/{token}`.
 *
 * ============================================================================
 * WHY THE TOKEN IS THE WHOLE ADDRESS
 * ============================================================================
 *
 * This is the load-bearing design decision in #110, because requirement 5 asks
 * for three distinct public codes — `410` for a consumed link, `404` for a
 * guessed one, and AB1's untouched `409` — and the URL shape is what decides
 * whether the `404` is even reachable.
 *
 * The obvious shape does not work. A token hung off the normal public event
 * URL — `/{accountCode}/{handle}/{slug}?k=<token>` — can never answer `404` for
 * a guess, because that page is PUBLIC and renders perfectly well with no
 * parameter at all. A wrong token would be indistinguishable from no token: the
 * visitor would simply get the ordinary booking page. The only way to make an
 * unknown token a genuinely missing route is for the token to BE the route, so
 * that failing to resolve it leaves nothing to render.
 *
 * Hence a dedicated top-level path whose entire address is the token. Three
 * things make that safe here, and each is a property this repo already holds
 * rather than a new promise:
 *
 *  1. `booking` CANNOT COLLIDE WITH AN ACCOUNT. It is in `RESERVED_PUBLIC_SLUGS`
 *     (`@slate/engine`), which `generateUniqueShortCode` skips and
 *     `validateVanitySlug` rejects, so no account code, vanity slug or alias can
 *     ever be `booking`. Next resolves the static segment ahead of the dynamic
 *     `[accountCode]` anyway, but the blocklist is what guarantees there is no
 *     real `/{accountCode}/{handle}` page being shadowed — and it is enforced
 *     and tested today rather than introduced by this unit.
 *
 *  2. `?embed=1` SURVIVES, because `booking` is NOT in `PRODUCT_PREFIXES`
 *     (`lib/theme.ts`). `isProductPath` therefore answers false, which means
 *     `frameAncestorsFor` leaves this route on `*` and the root layout paints it
 *     on the booking canvas rather than the product one. An invite link pasted
 *     into a host's own site frames exactly like a public booking page.
 *
 *  3. THE CANONICAL-ACCOUNT-CODE 308 CANNOT FIRE, because this path carries no
 *     account code. The two public booking routes rebuild their redirect target
 *     by hand and have to carry the whole query through `withSearchParams` so an
 *     alias-coded embed does not silently 308 into a full-chrome page. Here the
 *     hazard is structurally absent: there is no alias to canonicalise. The
 *     route reads the CANONICAL code straight off the resolve call, so a link
 *     minted before the host claimed a vanity slug keeps working afterwards —
 *     the link stores an event-type id, not a URL.
 *
 * ============================================================================
 * WHAT THE STATUS CODES ACTUALLY ARE HERE
 * ============================================================================
 *
 * The split is EXACT ON THE API, which is where the contract is testable and
 * where an integration meets it: `GET /v1/public/one-off/:token` answers 200,
 * 410 and 404, both booking writes answer 410 and 404, and
 * `apps/api/src/one-off-link.spec.ts` asserts all of it — including that a
 * guessed token answers the same STATUS and the same `error` code an unknown
 * booking page does, with a message that names nothing about invite links.
 * (The messages are not identical strings: every 404 on this API names the
 * thing that was missing — "Booking page not found.", "Team event not found."
 * — and this one says only "Not found.". What must not leak is the EXISTENCE
 * of invite links, and none of them mentions one.)
 *
 * ON THE WEB the requirement is met as WRITTEN — "indistinguishable from any
 * other missing route" — but not by the status line, and the difference is
 * worth stating rather than discovering. An unknown token calls `notFound()`
 * and renders the app's own not-found page; that page arrives with a 200 in
 * this app, because `notFound()` from ANY dynamic route here does (an unknown
 * event, an unknown handle and an unknown manage uid all behave the same way,
 * in dev and in a production build alike — only a path that matches no route at
 * all gets a 404 status). So a guessed token is genuinely indistinguishable
 * from a missing booking page, which is the property that matters; it is just
 * that both are 200 pages rather than both being 404s. That is pre-existing
 * app-wide behaviour, not something this route introduced, and changing it is
 * out of scope for #110.
 *
 * The spent-link state renders at 200 for a second, independent reason: the App
 * Router has no supported way for a page render to set an arbitrary status —
 * `notFound()` gives 404 and `redirect()` gives 307/308, and there is no 410
 * equivalent. Rendering the spent state as a 404 would be worse than the status
 * mismatch anyway, because it would tell the person the host invited that their
 * link never existed.
 */

/**
 * Never indexed, and never given an event title.
 *
 * A one-off link is sent to ONE person. Putting the event's name in a `<title>`
 * would leak it to anything that renders a link preview — a chat client
 * unfurling the URL, a mail scanner — for a page whose whole point is that only
 * the intended recipient sees it. It also costs the host nothing: the invitee
 * already knows what they were invited to.
 *
 * `noindex, nofollow` unconditionally, unlike the public routes which only set
 * it under `?embed=1`. A crawler that reaches one of these has reached a
 * private invitation.
 */
export const metadata: Metadata = {
  title: 'Booking',
  robots: { index: false, follow: false },
};

export default async function OneOffBookingPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<RawSearchParams>;
}) {
  const { token } = await params;
  const query = await searchParams;
  const lang = typeof query.lang === 'string' ? query.lang : undefined;
  const locale = await publicLocale(lang);
  const messages = getMessages(locale);
  // Inline embed (E) works here exactly as on the public routes — see point 2
  // in the header comment for why this path keeps its `*` frame-ancestors.
  const { embed, brandColor: accentOverride, style: styleOverrides } = parseEmbedParams(query);

  const resolved = await getOneOffLink(token);

  // An unknown or malformed token IS a missing route: the same not-found page,
  // reached the same way, with nothing on it that hints this deployment mints
  // invite links. See the header for what that does and does not mean about the
  // status line — `notFound()` renders at 200 here, as it does on every dynamic
  // route in this app, which is precisely why a guess is indistinguishable from
  // an unknown booking page.
  if (!resolved.ok && resolved.reason === 'not-found') notFound();

  const shellClass = embed ? EMBED_ROOT_CLASS : 'bp-viewport';
  const mainClass = embed
    ? 'mx-auto max-w-6xl px-4 py-4'
    : 'mx-auto w-full max-w-6xl px-4 py-10 sm:px-6 sm:py-12';

  // The link was real and is spent — consumed by a booking, or revoked by the
  // host. The invitee is told which of those it is by neither: to them it is one
  // state, and whether the host withdrew it is the host's business.
  if (!resolved.ok) {
    return (
      <BrandedShell
        brandColor={accentOverride}
        style={mergeEmbedStyle(null, styleOverrides)}
        className={shellClass}
      >
        <main className={mainClass}>
          {/* `bp-card` so a spent link looks like part of the same page rather
              than a different product — it inherits the host's own corner and
              surface styling like every other card here.

              NEUTRAL, deliberately, where the booking flow's failure cards
              carry a destructive border. A used invite link is not an error: it
              is the expected end of that link's life, reached by the person the
              host invited doing exactly what they were asked to do. Painting it
              red would tell them something went wrong when nothing did.

              No retry and no "pick another" either — nothing the invitee can do
              on this page resolves it, and an action that cannot work is worse
              than none. */}
          <section className="bp-card mx-auto max-w-2xl border border-border bg-card p-6">
            <h1 className="mb-1 text-lg font-semibold">{messages.booking.oneOffLink.usedTitle}</h1>
            <p className="text-sm text-muted-foreground">{messages.booking.oneOffLink.usedBody}</p>
          </section>
        </main>
        {/* No account code: a spent link does not tell us whose it was, and
            attributing the growth signal to the wrong workspace is worse than
            not attributing it. */}
        <MadeWithBadge locale={locale} />
        {embed ? <EmbedResizeReporter /> : null}
      </BrandedShell>
    );
  }

  const target = resolved.target;
  const now = new Date();
  const from = now.toISOString();
  // The same window the two public routes read, for the same reason: the month
  // calendar needs a whole month per view and the service clamps to this bound.
  const to = new Date(now.getTime() + MAX_AVAILABILITY_WINDOW_MS).toISOString();

  // From here the page is the ORDINARY booking page. It reads the same profile
  // and availability contracts the public routes read, with the token on a
  // header so the API will answer for the hidden event this link opens. Keeping
  // it the same page is what stops a one-off booking drifting from a public one.
  if (target.kind === 'team') {
    const [team, availability] = await Promise.all([
      getTeamProfile(target.accountCode, target.teamSlug),
      getTeamAvailabilityWithOneOff({
        accountCode: target.accountCode,
        teamSlug: target.teamSlug,
        slug: target.slug,
        from,
        to,
        oneOffToken: token,
      }),
    ]);
    // The link resolved but the event behind it did not answer. Treat it as a
    // missing route rather than a spent link: reporting "already used" for an
    // event that was archived would send the invitee back to the host with the
    // wrong question.
    if (!team || !availability) notFound();

    return (
      <BrandedShell
        brandColor={accentOverride}
        style={mergeEmbedStyle(null, styleOverrides)}
        className={shellClass}
      >
        <main className={mainClass}>
          <BookingFlow
            accountCode={target.accountCode}
            ownerSlug={target.teamSlug}
            slug={target.slug}
            mode="team"
            slots={availability.slots}
            emptyReason={availability.emptyReason}
            bookingFields={availability.eventType.bookingFields}
            initialTimeZone={availability.timeZone}
            locale={locale}
            eventTitle={availability.eventType.title}
            lengthMinutes={availability.eventType.lengthMinutes}
            // A hidden team event is not on the public team listing, so there is
            // no `eventTypes` row to read a description from. The availability
            // contract carries no description either; the panel simply has none.
            description={null}
            hostName={team.team.name}
            avatarUrl={team.team.logoUrl}
            location={availability.eventType.location}
            methodLabel={schedulingMethodLabel(messages, availability.eventType.schedulingType)}
            nowUtc={from}
            embed={embed}
            oneOffToken={token}
          />
        </main>
        <MadeWithBadge locale={locale} accountCode={target.accountCode} />
        {embed ? <EmbedResizeReporter /> : null}
      </BrandedShell>
    );
  }

  const [profile, availability] = await Promise.all([
    getProfile(target.accountCode, target.handle),
    getAvailabilityWithOneOff({
      accountCode: target.accountCode,
      handle: target.handle,
      slug: target.slug,
      from,
      to,
      oneOffToken: token,
    }),
  ]);
  if (!profile || !availability) notFound();

  const hostName = profile.member.displayName ?? profile.member.handle;
  // `profile.eventTypes` lists only VISIBLE events, so a hidden one — the case
  // this feature exists for — is deliberately absent and the panel shows no
  // description. A visible event reached through a link still finds its own.
  const listing = profile.eventTypes.find((e) => e.slug === target.slug);

  return (
    <BrandedShell
      brandColor={accentOverride ?? profile.member.brandColor}
      style={mergeEmbedStyle(profile.member.style, styleOverrides)}
      className={shellClass}
    >
      <main className={mainClass}>
        <BookingFlow
          accountCode={target.accountCode}
          ownerSlug={target.handle}
          slug={target.slug}
          slots={availability.slots}
          emptyReason={availability.emptyReason}
          bookingFields={availability.eventType.bookingFields}
          initialTimeZone={availability.timeZone}
          locale={locale}
          eventTitle={availability.eventType.title}
          lengthMinutes={availability.eventType.lengthMinutes}
          description={listing?.description ?? null}
          hostName={hostName}
          avatarUrl={resolveAvatarUrl(profile.member.avatarUrl, profile.member.connectedAvatarUrl)}
          location={availability.eventType.location}
          nowUtc={from}
          embed={embed}
          oneOffToken={token}
        />
      </main>
      <MadeWithBadge locale={locale} accountCode={target.accountCode} />
      {embed ? <EmbedResizeReporter /> : null}
    </BrandedShell>
  );
}
