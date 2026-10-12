/**
 * Frozen inputs for the public-surface markup pins (`public-markup.spec.tsx`,
 * `public-steps.spec.tsx`).
 *
 * Every host, account and address here is invented. The clock is frozen at
 * `NOW`, a Monday, and the slots are generated from it, so a snapshot written
 * today renders the same month, the same "today" and the same times next year.
 */
import type { AvailabilityResponse, BookingView, PublicProfile } from '@slate/types';

/** The instant every pinned render happens at: Monday 2 March 2026, 9:00 in New York. */
export const NOW = '2026-03-02T14:00:00.000Z';

export const TIME_ZONE = 'America/New_York';

export const ACCOUNT = { code: 'northwind', name: 'Northwind Studio' };

/** The style a host saves when they never touched an axis but did pick a canvas. */
export const BASE_STYLE = {
  template: 'classic',
  cardStyle: 'outline',
  corners: 'soft',
  buttons: 'rounded',
  density: 'comfortable',
  font: 'sans',
  slotLayout: 'grid',
  dayGroup: 'flat',
  slotSelect: 'soft',
  landingEnabled: true,
  defaultEventSlug: null,
  bio: 'Product design reviews and portfolio feedback.',
} as const;

export const TEMPLATES = ['classic', 'split', 'banded'] as const;
export const CANVASES = ['light', 'dark'] as const;
export const SLOT_LAYOUTS = ['grid', 'list'] as const;

export function profile(style: Record<string, unknown>, brandColor: string | null = '#2f6fed'): PublicProfile {
  return {
    account: ACCOUNT,
    member: {
      handle: 'riley-chen',
      displayName: 'Riley Chen',
      timeZone: TIME_ZONE,
      avatarUrl: null,
      connectedAvatarUrl: null,
      coverUrl: null,
      brandColor,
      layout: null,
      style: style as PublicProfile['member']['style'],
    },
    eventTypes: [
      {
        slug: 'design-review',
        title: 'Design review',
        description: 'Bring a screen or a flow. We go through it together and you leave with a list.',
        lengthMinutes: 45,
      },
      {
        slug: 'intro',
        title: 'Intro call',
        description: null,
        lengthMinutes: 15,
      },
    ],
  };
}

/**
 * Weekday slots for three weeks from `NOW`: 9:00 to 11:30 New York time, every
 * 30 minutes. The first day starts at 10:00, because 9:00 on the frozen Monday
 * is the frozen instant itself.
 */
export function slots(): AvailabilityResponse['slots'] {
  const out: AvailabilityResponse['slots'] = [];
  const start = Date.parse(NOW);
  for (let day = 0; day < 21; day++) {
    const base = start + day * 86_400_000;
    const weekday = new Date(base).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    for (let i = 0; i < 6; i++) {
      const t = base + i * 30 * 60_000;
      if (t <= start) continue;
      out.push({ startUtc: new Date(t).toISOString() });
    }
  }
  return out;
}

export function availability(): AvailabilityResponse {
  return {
    eventType: {
      slug: 'design-review',
      title: 'Design review',
      lengthMinutes: 45,
      bookingFields: [
        { name: 'company', label: 'Company', type: 'text', required: true },
        { name: 'topic', label: 'What should we look at?', type: 'textarea', required: false },
      ],
      schedulingType: null,
      location: { kind: 'conferencing' },
    },
    timeZone: TIME_ZONE,
    slots: slots(),
  } as AvailabilityResponse;
}

export function booking(overrides: Partial<BookingView> = {}): BookingView {
  return {
    uid: 'bk_pinned_0001',
    status: 'accepted',
    title: 'Design review',
    startUtc: '2026-03-04T15:00:00.000Z',
    endUtc: '2026-03-04T15:45:00.000Z',
    host: { name: 'Riley Chen', handle: 'riley-chen' },
    attendee: { name: 'Sam Visitor', email: 'sam@example.com', timeZone: TIME_ZONE },
    location: null,
    locationKind: 'conferencing',
    meetingUrl: 'https://meet.example.com/abc-defg',
    manageUrl: '/manage/bk_pinned_0001?token=tok_pinned',
    reschedule: { kind: 'personal', accountCode: ACCOUNT.code, handle: 'riley-chen', slug: 'design-review' },
    ...overrides,
  } as BookingView;
}

/** One line per element, so a markup change reads as a diff a person can review. */
export function pretty(html: string): string {
  return `${html.replace(/></g, '>\n<')}\n`;
}
