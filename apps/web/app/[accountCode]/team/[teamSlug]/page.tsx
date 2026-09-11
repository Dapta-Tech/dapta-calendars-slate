import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, permanentRedirect } from 'next/navigation';
import { getMessages, t } from '@slate/shared';
import { getTeamProfile } from '@/lib/api';
import { publicLocale } from '@/lib/locale';
import { DEFAULT_BOOKING_CANVAS } from '@/lib/booking-canvas';
import { BrandedShell } from '@/components/branded-shell';
import { CanvasStamp } from '@/components/canvas-stamp';
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

// Per-page SEO/OG from team data (R11 audit); getTeamProfile is request-cached.
export async function generateMetadata({
  params,
  searchParams,
}: {
  params: Promise<{ accountCode: string; teamSlug: string }>;
  searchParams: Promise<RawSearchParams>;
}): Promise<Metadata> {
  const { accountCode, teamSlug } = await params;
  const query = await searchParams;
  const team = await getTeamProfile(accountCode, teamSlug);
  if (!team) return {};
  const title = `${team.team.name} — ${team.account.name}`;
  const description = t(getMessages(await publicLocale()).growth.seoProfile, {
    name: team.team.name,
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

export default async function TeamPage({
  params,
  searchParams,
}: {
  params: Promise<{ accountCode: string; teamSlug: string }>;
  searchParams: Promise<RawSearchParams>;
}) {
  const { accountCode, teamSlug } = await params;
  const query = await searchParams;
  const [team, locale] = await Promise.all([getTeamProfile(accountCode, teamSlug), publicLocale()]);
  if (!team) notFound();

  // Canonical-code guard (short-links §4): alias URLs 308 to the canonical code.
  const code = team!.account.code;
  if (accountCode !== code) permanentRedirect(withSearchParams(`/${code}/team/${teamSlug}`, query));

  // Inline embed (E). A team has no stored brandColor or style in the model, so
  // this route renders no `BrandedShell` at all outside the embed and renders
  // byte-for-byte as it does on `develop`. Under `embed=1` it gets one, built
  // from the URL overrides alone — otherwise "the theme params work on all four
  // public routes" would be a promise this page does not keep. Wrapping it
  // unconditionally would repaint a page nobody asked to change.
  const { embed, brandColor: accentOverride, style: styleOverrides } = parseEmbedParams(query);
  const body = (
    <>
      <main className={embed ? 'mx-auto max-w-2xl px-4 py-4' : 'mx-auto max-w-2xl px-6 py-16'}>
        <header className="mb-8 flex flex-col gap-1">
          <p className="text-sm text-muted-foreground">{team.account.name}</p>
          <h1 className="text-3xl font-semibold tracking-tight">{team.team.name}</h1>
          <p className="text-sm text-muted-foreground">Times in {team.team.timeZone}</p>
        </header>

        <ul className="flex flex-col gap-3">
          {team.eventTypes.map((et) => (
            <li key={et.slug}>
              <Link
                // The mode and the overrides travel with an in-frame
                // navigation, or picking an event from a styled embed lands on
                // an unstyled full-chrome page inside the frame.
                href={withSearchParams(`/${code}/team/${teamSlug}/${et.slug}`, query)}
                className="flex items-center justify-between rounded-md border border-border bg-card p-4 transition-transform hover:border-primary active:scale-[0.99]"
              >
                <span className="flex flex-col">
                  <span className="font-medium">{et.title}</span>
                  {et.description ? (
                    <span className="text-sm text-muted-foreground">{et.description}</span>
                  ) : null}
                </span>
                <span className="rounded-sm bg-muted px-2 py-1 text-sm text-muted-foreground">
                  {et.lengthMinutes} min
                </span>
              </Link>
            </li>
          ))}
          {team.eventTypes.length === 0 ? (
            <li className="text-muted-foreground">No bookable team events yet.</li>
          ) : null}
        </ul>
      </main>
      <MadeWithBadge locale={locale} accountCode={code} />
      {embed ? <EmbedResizeReporter /> : null}
    </>
  );

  return embed ? (
    <BrandedShell
      brandColor={accentOverride}
      style={mergeEmbedStyle(null, styleOverrides)}
      className={EMBED_ROOT_CLASS}
    >
      {body}
    </BrandedShell>
  ) : (
    // The fourth public shell, centred like the other three — a team's entry
    // page sitting at the top while every page reachable from it is centred is
    // the inconsistency an invitee actually notices. It renders no
    // `BrandedShell` outside the embed, so the floor needs an element of its
    // own; inside the embed it keeps the measured shell untouched.
    //
    // It declares its canvas here for the same reason `/manage/{uid}` does: with
    // no shell there is nothing else to carry the answer up to `<html>` on a
    // soft navigation. A team holds no stored branding, so the answer is the
    // ADR default — and in embed mode the branch above gets it from the shell.
    <div className="bp-viewport">
      <CanvasStamp canvas={DEFAULT_BOOKING_CANVAS} />
      {body}
    </div>
  );
}
