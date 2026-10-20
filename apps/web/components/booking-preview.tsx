'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  brandVars,
  brandingClassOf,
  getMessages,
  widgetStyleVars,
  type PublicBranding,
  type Slot,
} from '@slate/shared';
import { bookingCanvasOf } from '@/lib/booking-canvas';
import type { BookingField } from '@slate/types';
import { BookingFlow } from '@/components/booking-flow';
import { ProfileView, type ProfileEvent } from '@/components/profile-view';
import { GrowthCta } from '@/components/booking-page-parts';
import { signupHref } from '@/lib/growth';

/**
 * The studio's preview of the event page: the REAL island, not a drawing of it.
 *
 * It used to be a mock that copied the public markup's class names, so "preview
 * == production" was a promise two files had to keep, and every change to the
 * page had to be made twice. Now the studio renders `BookingFlow` itself, with
 * sample times, inside the same `.branded-surface` wrapper and the same booking
 * ground the public shell uses; `preview-parity.spec.tsx` proves the two
 * produce the same HTML for the same config.
 *
 * It is `inert`: nothing in it can be focused or clicked, and it is hidden from
 * the accessibility tree, because it is a picture of a page for the host, not a
 * page. That is also why the island's server actions are safe to have here:
 * nothing can reach them.
 *
 * The sample is FIXED (a September 2026 month, times from 9:00 to 11:30 UTC on
 * weekdays), so the preview renders identically on the server and after
 * hydration, and does not change shape at midnight.
 */

/** The instant the preview pretends it is: the morning of its sample "today". */
export const PREVIEW_NOW = '2026-09-10T07:00:00.000Z';
const PREVIEW_DAYS = [
  '2026-09-10',
  '2026-09-11',
  '2026-09-14',
  '2026-09-15',
  '2026-09-16',
  '2026-09-17',
  '2026-09-18',
  '2026-09-21',
  '2026-09-22',
  '2026-09-23',
  '2026-09-24',
  '2026-09-25',
  '2026-09-28',
  '2026-09-29',
  '2026-09-30',
];

/** The preview's sample times: every half hour from 9:00 to 11:30 UTC, each sample day. */
export function previewSlots(): Slot[] {
  return PREVIEW_DAYS.flatMap((day) =>
    ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30'].map((hm) => ({ startUtc: `${day}T${hm}:00.000Z` })),
  );
}

/** Everything the island needs to render the sample, for the studio and for the parity spec. */
export function previewFlowProps({
  hostName,
  avatarUrl,
  eventTitle,
  locale,
  logoUrl = null,
}: {
  hostName: string;
  avatarUrl: string | null;
  eventTitle: string;
  locale: string;
  /** The brand kit's logo, when the page being previewed wears one. */
  logoUrl?: string | null;
}) {
  return {
    // The preview is inert and never reaches the confirmation; the profile
    // preview below is where the branding switch shows.
    showBranding: true,
    accountCode: 'preview',
    ownerSlug: 'preview',
    slug: 'preview',
    slots: previewSlots(),
    bookingFields: [] as BookingField[],
    initialTimeZone: 'UTC',
    followBrowserZone: false,
    locale,
    eventTitle,
    lengthMinutes: 30,
    hostName,
    avatarUrl,
    logoUrl,
    location: null,
    nowUtc: PREVIEW_NOW,
  };
}

/**
 * The desktop page at its real width, scaled to fit the preview box.
 *
 * The page lays out by the width of its container, so a desktop preview has to
 * BE desktop width for the layout inside it to be the desktop one. `zoom` (not
 * `transform: scale`) so the box it occupies shrinks with it and the studio's
 * frame stays the size of what it shows.
 */
function DesktopZoom({ width, children }: { width: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(0.4);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setZoom(Math.min(1, entry.contentRect.width / width));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [width]);
  return (
    <div ref={ref} className="w-full">
      <div style={{ width, zoom }}>{children}</div>
    </div>
  );
}

/** The width the desktop preview renders the page at: the three-across layout. */
const DESKTOP_WIDTH = 1152;

export function BookingPreview({
  hostName,
  avatarUrl,
  eventTitle,
  locale,
  device,
  logoUrl = null,
}: {
  hostName: string;
  avatarUrl: string | null;
  eventTitle: string;
  locale: string;
  device: 'desktop' | 'mobile';
  logoUrl?: string | null;
}) {
  const props = useMemo(
    () => previewFlowProps({ hostName, avatarUrl, eventTitle, locale, logoUrl }),
    [hostName, avatarUrl, eventTitle, locale, logoUrl],
  );
  const flow = <BookingFlow {...props} />;
  return (
    <div aria-hidden="true" inert>
      {device === 'desktop' ? <DesktopZoom width={DESKTOP_WIDTH}>{flow}</DesktopZoom> : flow}
    </div>
  );
}

type FrameAxes = Partial<
  Pick<
    PublicBranding,
    | 'template'
    | 'cardStyle'
    | 'corners'
    | 'buttons'
    | 'density'
    | 'font'
    | 'slotLayout'
    | 'dayGroup'
    | 'slotSelect'
    | 'theme'
  >
>;

/**
 * The studio's preview frame: the admin chrome around the invitee's page, and
 * the invitee's page's own ground inside it.
 *
 * It STAMPS the invitee's canvas and paints its ground, because `--accent-wash`
 * is `color-mix(…, var(--background))`: with the ground falling through to the
 * admin's, the accent would match the live page while every wash and card
 * behind it came from the AUTHOR's theme. `bp-ground` gives it the booking
 * page's palette for that canvas (tokens.css), the one `BrandedShell` resolves,
 * and the vars and classes come from the same functions the shell calls, with
 * the same canvas. Stamped on the frame rather than an inner element so the
 * padding around the page is the page's own ground, not a rim of the admin's;
 * `overflow-x-auto` so the fixed 360px phone preview scrolls inside its frame
 * instead of widening the studio at 360px.
 */
export function PreviewFrame({
  accent,
  axes,
  device,
  wide,
  children,
}: {
  accent: string;
  axes: FrameAxes;
  device: 'desktop' | 'mobile';
  /** The event page previews at the frame's full width (it is zoomed); the profile at a column. */
  wide: boolean;
  children: ReactNode;
}) {
  const canvas = bookingCanvasOf(axes);
  const vars = { ...brandVars(accent, canvas), ...widgetStyleVars(axes) } as React.CSSProperties;
  return (
    <div
      data-theme={canvas}
      className="bp-ground overflow-x-auto rounded-xl border border-border bg-background p-card text-foreground sm:p-group"
      style={vars}
    >
      <div
        className={`${brandingClassOf(axes)} ${
          device === 'mobile' ? 'mx-auto w-[360px]' : wide ? 'w-full' : 'mx-auto max-w-md'
        }`}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * The studio's preview of the host's profile: the same `ProfileView` the public
 * route renders, from the studio's unsaved values, inert. With no events it
 * shows the sentence the public page shows, not a made-up sample.
 */
export function ProfilePreview({
  locale,
  displayName,
  accountName,
  bio,
  avatarUrl,
  coverUrl,
  events,
  logoUrl = null,
  accountCode = null,
  showBranding = true,
}: {
  /** The account's public code, for the call to action's link (as the profile). */
  accountCode?: string | null;
  /** What the public pages carry right now (`showing` from the branding settings). */
  showBranding?: boolean;
  locale: string;
  displayName: string;
  accountName: string | null;
  bio: string;
  avatarUrl: string;
  coverUrl: string;
  logoUrl?: string | null;
  events: Array<Omit<ProfileEvent, 'description'> & { description?: string | null }>;
}) {
  const m = getMessages(locale);
  // The same link the public profile carries, campaign tags included.
  const cta = signupHref('profile', accountCode, showBranding);
  return (
    <div aria-hidden="true" inert>
      <ProfileView
        m={m}
        name={displayName}
        context={accountName}
        bio={bio || null}
        avatarUrl={avatarUrl || null}
        coverUrl={coverUrl || null}
        events={events.map((e) => ({ ...e, description: e.description ?? null }))}
        hrefFor={() => '#'}
        emptyText={m.landing.noEvents}
        logoUrl={logoUrl}
        // The public profile ends with this when the deployment has a signup
        // destination; the picture of it does too.
        footer={cta ? <GrowthCta m={m} href={cta} /> : null}
      />
    </div>
  );
}
