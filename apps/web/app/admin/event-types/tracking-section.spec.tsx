// @vitest-environment jsdom
/**
 * The editor's "Tracking and pixels" section: one field per vendor opening on
 * the stored id, each with the line that says what its tag hears; Meta and
 * PostHog for every owner and admin, GTM, GA4 and HubSpot only where the
 * deployment allows them; the PostHog cloud a choice of US or EU. An id not in
 * its vendor's format is refused beside its field (after a blur or a save
 * attempt) without sending the save, focus on the first bad field; the save
 * carries the trimmed ids, blank ones left out, or null when none is left.
 * Personal and team events, EN and ES.
 */
import { act, type AnchorHTMLAttributes, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getMessages, type Locale } from '@slate/shared';
import type { EventType } from '@/lib/admin-api';

vi.mock('next/link', () => ({
  default: ({
    children,
    ...rest
  }: AnchorHTMLAttributes<HTMLAnchorElement> & { children: ReactNode }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/components/toast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), toast: vi.fn() }),
}));
vi.mock('./actions', () => ({
  listOneOffLinksAction: vi.fn(async () => ({ ok: true, links: [] })),
  mintOneOffLinkAction: vi.fn(),
  revokeOneOffLinkAction: vi.fn(),
  saveEventTypeAction: vi.fn(),
  refreshCrmPropertiesAction: vi.fn(),
}));

import { saveEventTypeAction, type EventTypePayload } from './actions';
import { EventTypeForm } from './event-type-form';

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Element.prototype.scrollIntoView = () => {};
});

beforeEach(() => {
  vi.mocked(saveEventTypeAction).mockReset().mockResolvedValue({ ok: true });
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

const event = (over: Partial<EventType> = {}): EventType => ({
  id: 'et-1',
  memberId: 'mem-1',
  teamId: null,
  slug: 'intro',
  title: 'Intro',
  description: null,
  lengthMinutes: 30,
  location: null,
  hidden: false,
  minimumBookingNotice: 120,
  beforeEventBuffer: 0,
  afterEventBuffer: 0,
  slotInterval: 30,
  schedulingType: null,
  requiresConfirmation: false,
  preventDuplicateBookings: false,
  seatsPerTimeSlot: null,
  bookingFields: [],
  reminders: [],
  hostMemberIds: [],
  hosts: [],
  scheduleId: null,
  conflictCalendarIds: [],
  destinationCalendarId: null,
  crmPropertyMappings: null,
  ...over,
});

async function mount(initial: EventType, locale: Locale = 'en', team = false, trackingEnabled = true, hostScriptsEnabled = true) {
  const msgs = getMessages(locale);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <EventTypeForm
        initial={initial}
        messages={msgs.admin.eventTypes}
        locationLabels={msgs.location}
        scheduling={team ? msgs.scheduling : undefined}
        teamMembers={team ? [] : undefined}
        teamName={team ? 'Sales' : undefined}
        backHref="/admin/event-types"
        backLabel="Events"
        heading="Intro"
        locale={locale}
        trackingEnabled={trackingEnabled}
        hostScriptsEnabled={hostScriptsEnabled}
      />,
    ),
  );
  return container;
}

type LabelKey = 'gtmLabel' | 'ga4Label' | 'metaLabel' | 'posthogKeyLabel' | 'posthogHostLabel' | 'hubspotLabel';
function wrapperOf(el: HTMLElement, key: LabelKey, locale: Locale): HTMLLabelElement | undefined {
  const label = getMessages(locale).admin.eventTypes.tracking[key];
  return [...el.querySelectorAll('label')].find((l) => l.textContent?.startsWith(label));
}
function field(el: HTMLElement, key: LabelKey, locale: Locale = 'en'): HTMLInputElement {
  return wrapperOf(el, key, locale)!.querySelector('input')!;
}
function cloud(el: HTMLElement, locale: Locale = 'en'): HTMLSelectElement {
  return wrapperOf(el, 'posthogHostLabel', locale)!.querySelector('select')!;
}

async function typeInto(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function pick(select: HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function save(el: HTMLElement) {
  await act(async () => el.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
}

const saved = () => vi.mocked(saveEventTypeAction).mock.lastCall?.[0] as EventTypePayload | undefined;

const PH_KEY = 'phc_abcdefghijklmnopqrstuvwxyz0123456789';
const STORED = {
  gtmId: 'GTM-AB12',
  ga4Id: 'G-ABC123XYZ9',
  metaPixelId: '123456789',
  posthogKey: PH_KEY,
  posthogHost: 'https://eu.i.posthog.com',
  hubspotTrackingId: '2468',
};

describe('Tracking and pixels, in the event type editor', () => {
  it('opens on the stored ids and saves them as they are', async () => {
    const el = await mount(event({ tracking: STORED }));
    expect(field(el, 'gtmLabel').value).toBe('GTM-AB12');
    expect(field(el, 'ga4Label').value).toBe('G-ABC123XYZ9');
    expect(field(el, 'metaLabel').value).toBe('123456789');
    expect(field(el, 'posthogKeyLabel').value).toBe(PH_KEY);
    expect(cloud(el).value).toBe('eu');
    expect(field(el, 'hubspotLabel').value).toBe('2468');
    await save(el);
    expect(saved()?.tracking).toEqual(STORED);
  });

  it('opens empty on an event without ids, and saves null', async () => {
    const el = await mount(event());
    expect(field(el, 'gtmLabel').value).toBe('');
    expect(field(el, 'gtmLabel').getAttribute('placeholder')).toBe('GTM-XXXXXXX');
    expect(field(el, 'ga4Label').getAttribute('placeholder')).toBe('G-XXXXXXXXXX');
    expect(cloud(el).value).toBe('');
    await save(el);
    expect(saved()?.tracking).toBeNull();
  });

  it('trims what it sends, upper-cases GTM and GA4, and leaves blank ids out', async () => {
    const el = await mount(event());
    await typeInto(field(el, 'metaLabel'), '  987654321  ');
    await typeInto(field(el, 'ga4Label'), ' g-abc123xyz9 ');
    await typeInto(field(el, 'gtmLabel'), '   ');
    await save(el);
    expect(saved()?.tracking).toEqual({ metaPixelId: '987654321', ga4Id: 'G-ABC123XYZ9' });
  });

  it('the PostHog cloud is US or EU, nothing else; US is the default and saves as none', async () => {
    const el = await mount(event());
    const options = [...cloud(el).querySelectorAll('option')].map((o) => [o.value, o.textContent]);
    const m = getMessages('en').admin.eventTypes.tracking;
    expect(options).toEqual([['', m.posthogHostUs], ['eu', m.posthogHostEu]]);
    await typeInto(field(el, 'posthogKeyLabel'), PH_KEY);
    await save(el);
    expect(saved()?.tracking).toEqual({ posthogKey: PH_KEY });
    await pick(cloud(el), 'eu');
    await save(el);
    expect(saved()?.tracking).toEqual({ posthogKey: PH_KEY, posthogHost: 'https://eu.i.posthog.com' });
  });

  for (const locale of ['en', 'es'] as const) {
    const m = getMessages(locale).admin.eventTypes.tracking;

    it(`says what each tag hears, and refuses an id not in its vendor's format beside its field (${locale})`, async () => {
      const el = await mount(event(), locale);
      for (const help of [m.metaHelp, m.ga4Help, m.posthogKeyHelp, m.posthogHostHelp, m.gtmHelp, m.hubspotHelp]) {
        expect(el.textContent).toContain(help);
      }
      expect(el.textContent).toContain(m.subtitle);
      expect(el.textContent).not.toContain(m.hostScriptsUnavailable);
      await typeInto(field(el, 'metaLabel', locale), '12ab34');
      await typeInto(field(el, 'ga4Label', locale), 'UA-1234-5');
      await typeInto(field(el, 'gtmLabel', locale), 'GTM 12');
      expect(el.querySelector('[role="alert"]')).toBeNull();
      await save(el);
      expect(saveEventTypeAction).not.toHaveBeenCalled();
      const alerts = [...el.querySelectorAll('[role="alert"]')].map((a) => a.textContent);
      expect(alerts).toEqual([m.metaInvalid, m.gtmInvalid, m.ga4Invalid]);
      expect(document.activeElement).toBe(field(el, 'metaLabel', locale));
      await typeInto(field(el, 'metaLabel', locale), '123456789');
      await typeInto(field(el, 'ga4Label', locale), 'G-ABC123XYZ9');
      await typeInto(field(el, 'gtmLabel', locale), 'GTM-12AB');
      await save(el);
      expect(saved()?.tracking).toEqual({ metaPixelId: '123456789', ga4Id: 'G-ABC123XYZ9', gtmId: 'GTM-12AB' });
    });
  }

  it('shows a field\'s error once it is left, not on the first keystroke', async () => {
    const el = await mount(event());
    const input = field(el, 'hubspotLabel');
    await typeInto(input, '12 34');
    expect(el.querySelector('[role="alert"]')).toBeNull();
    await act(async () => input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })));
    expect(el.querySelector('[role="alert"]')?.textContent).toBe(getMessages('en').admin.eventTypes.tracking.hubspotInvalid);
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('where the deployment does not offer GTM, GA4 and HubSpot: the other ids still edit, those stay as stored', async () => {
    const el = await mount(event({ tracking: { gtmId: 'GTM-AB12', ga4Id: 'G-ABC123XYZ9', metaPixelId: '123456789' } }), 'en', false, true, false);
    const m = getMessages('en').admin.eventTypes.tracking;
    expect(wrapperOf(el, 'gtmLabel', 'en')).toBeUndefined();
    expect(wrapperOf(el, 'ga4Label', 'en')).toBeUndefined();
    expect(wrapperOf(el, 'hubspotLabel', 'en')).toBeUndefined();
    expect(el.textContent).toContain(m.hostScriptsUnavailable);
    await typeInto(field(el, 'posthogKeyLabel'), PH_KEY);
    await save(el);
    // The stored container and property go back unchanged; the API lets that through.
    expect(saved()?.tracking).toEqual({ gtmId: 'GTM-AB12', ga4Id: 'G-ABC123XYZ9', metaPixelId: '123456789', posthogKey: PH_KEY });
  });

  it('is not offered, and the save leaves the ids alone, for a plain member', async () => {
    const el = await mount(event({ tracking: STORED }), 'en', false, false, false);
    expect(el.textContent).not.toContain(getMessages('en').admin.eventTypes.tracking.title);
    await save(el);
    expect(saved()).toBeDefined();
    expect(saved()).not.toHaveProperty('tracking');
  });

  it('is offered on team events too, and travels on their save', async () => {
    const el = await mount(
      event({ memberId: null, teamId: 'team-1', schedulingType: 'round_robin', tracking: { gtmId: 'GTM-TEAM1' } }),
      'en',
      true,
    );
    expect(field(el, 'gtmLabel').value).toBe('GTM-TEAM1');
    await save(el);
    expect(saved()?.tracking).toEqual({ gtmId: 'GTM-TEAM1' });
  });
});
