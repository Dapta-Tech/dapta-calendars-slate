// @vitest-environment jsdom
/**
 * The two loaders: what each tells the vendor on mount, that a click on a
 * growth link is counted with its medium, and that with analytics off (every
 * bare fork) neither touches the page at all.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AnalyticsConfig } from '@slate/shared';
import { HostAnalytics } from './host-analytics';
import { VisitorAnalytics } from './visitor-analytics';
import { resetPosthogForTests } from '@/lib/analytics/posthog';
import { track } from '@/lib/analytics/port';

const CONFIG: AnalyticsConfig = { provider: 'posthog', key: 'phc_test', host: 'https://ingest.example.test' };

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  delete (window as unknown as { posthog?: unknown }).posthog;
  window.localStorage.clear();
  resetPosthogForTests();
});

/** A loaded vendor global that records every call per instance. */
function vendor() {
  const calls: Array<[string, string, unknown[]]> = [];
  const global: Record<string, unknown> = {
    __SV: 1,
    init: vi.fn((_k: string, _c: unknown, name: string) => {
      global[name] = new Proxy(
        {},
        { get: (_t, method: string) => (...args: unknown[]) => void calls.push([name, method, args]) },
      );
    }),
  };
  (window as unknown as { posthog?: unknown }).posthog = global;
  return { calls, init: global['init'] as ReturnType<typeof vi.fn> };
}

async function mount(node: React.ReactNode) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(node));
}

const IDENTITY = {
  email: 'host@example.test',
  memberId: 'm1',
  accountKey: 'abc123',
  role: 'owner',
  isInternal: false,
  landingId: '0198a1b2-c3d4',
};

describe('HostAnalytics', () => {
  it('identifies by email, joins the landing visit after identify, then registers and groups', async () => {
    const v = vendor();
    await mount(<HostAnalytics config={CONFIG} identity={IDENTITY} />);
    expect(v.init.mock.calls[0]![2]).toBe('calendars_host');
    expect(v.calls.map(([, m]) => m)).toEqual(['identify', 'alias', 'register', 'group']);
    expect(v.calls[0]![2]).toEqual([
      'host@example.test',
      { email: 'host@example.test', member_id: 'm1', role: 'owner', is_internal: false },
    ]);
    // Named explicitly: the library replays a queued alias before identify.
    expect(v.calls[1]![2]).toEqual(['0198a1b2-c3d4', 'host@example.test']);
    expect(v.calls[2]![2]![0]).toMatchObject({ product: 'calendars', account_code: 'abc123', surface: 'dashboard' });
    // The browser joins the group but never sets the account's own facts.
    expect(v.calls[3]![2]).toEqual(['calendars_account', 'abc123', undefined]);
  });

  it('aliases a landing id once per browser', async () => {
    const v = vendor();
    await mount(<HostAnalytics config={CONFIG} identity={IDENTITY} />);
    act(() => root!.unmount());
    root = createRoot(container!);
    await act(async () => root!.render(<HostAnalytics config={CONFIG} identity={IDENTITY} />));
    expect(v.calls.filter(([, m]) => m === 'alias')).toHaveLength(1);
  });

  it('routes browser events to the host instance while mounted', async () => {
    const v = vendor();
    await mount(<HostAnalytics config={CONFIG} identity={{ ...IDENTITY, landingId: null }} />);
    track('link_copied');
    expect(v.calls.at(-1)).toEqual(['calendars_host', 'capture', ['calendars_link_copied', undefined]]);
  });

  it('does nothing at all with analytics off', async () => {
    await mount(<HostAnalytics config={null} identity={IDENTITY} />);
    expect((window as unknown as { posthog?: unknown }).posthog).toBeUndefined();
    expect(document.querySelector('script')).toBeNull();
  });
});

describe('VisitorAnalytics', () => {
  it('counts the page view, tagged with the account, and never identifies', async () => {
    const v = vendor();
    await mount(<VisitorAnalytics config={CONFIG} page="event" accountKey="abc123" embed={false} />);
    expect(v.init.mock.calls[0]![2]).toBe('calendars_visitor');
    expect(v.calls.map(([, m]) => m)).toEqual(['register', 'capture']);
    expect(v.calls[0]![2]![0]).toMatchObject({ product: 'calendars', surface: 'booking_page', account_code: 'abc123', embed: false });
    expect(v.calls[1]![2]).toEqual(['calendars_booking_page_viewed', { page: 'event' }]);
  });

  it('counts a growth link click with the medium off its own UTM tags', async () => {
    const v = vendor();
    await mount(
      <>
        <VisitorAnalytics config={CONFIG} page="profile" accountKey="abc123" embed={false} />
        <a data-analytics-cta="" href="https://signup.example.test/?utm_source=x&utm_medium=badge">
          <span>Made with</span>
        </a>
        <a href="https://elsewhere.example.test/">not a growth link</a>
      </>,
    );
    const [badge, other] = Array.from(container!.querySelectorAll('a'));
    badge!.addEventListener('click', (e) => e.preventDefault());
    other!.addEventListener('click', (e) => e.preventDefault());
    act(() => badge!.querySelector('span')!.click());
    act(() => other!.click());
    const clicks = v.calls.filter(([, m, a]) => m === 'capture' && a[0] === 'calendars_cta_clicked');
    expect(clicks).toEqual([['calendars_visitor', 'capture', ['calendars_cta_clicked', { utm_medium: 'badge', page: 'profile' }]]]);
  });

  it('does nothing at all with analytics off', async () => {
    await mount(<VisitorAnalytics config={null} page="event" accountKey="abc123" embed={false} />);
    expect((window as unknown as { posthog?: unknown }).posthog).toBeUndefined();
  });
});
