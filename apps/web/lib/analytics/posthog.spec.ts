// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnalyticsConfig } from '@slate/shared';
import { connectPosthog, posthogSettings, resetPosthogForTests, scrubEvent, withoutQuery } from './posthog';
import { clearActiveAnalyticsPort, resetAnalytics, setActiveAnalyticsPort, track, type AnalyticsPort } from './port';

const CONFIG: AnalyticsConfig = { provider: 'posthog', key: 'phc_test', host: 'https://ingest.example.test' };

/** A loaded vendor global: `__SV` set, so no stub is installed, and every call recorded. */
function loadedVendor() {
  const calls: Array<[string, string, unknown[]]> = [];
  const instance = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, method: string) => (...args: unknown[]) => void calls.push([name, method, args]),
      },
    );
  const global: Record<string, unknown> = {
    __SV: 1,
    init: vi.fn((_key: string, _config: Record<string, unknown>, name: string) => {
      global[name] = instance(name);
    }),
  };
  (window as unknown as { posthog?: unknown }).posthog = global;
  return { global, calls, init: global['init'] as ReturnType<typeof vi.fn> };
}

afterEach(() => {
  delete (window as unknown as { posthog?: unknown }).posthog;
  resetPosthogForTests();
});

describe('posthogSettings', () => {
  const location = { location: { pathname: '/admin' } as Location };

  it('a visitor gets no profile, no storage, no recording, no autocapture, no pageviews', () => {
    expect(posthogSettings(CONFIG, 'visitor', location)).toMatchObject({
      api_host: CONFIG.host,
      person_profiles: 'never',
      persistence: 'memory',
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      disable_session_recording: true,
      capture_heatmaps: false,
      capture_dead_clicks: false,
      rageclick: false,
      capture_exceptions: false,
      disable_surveys: true,
    });
  });

  it('a host gets pageviews, but still no recording and no autocapture', () => {
    expect(posthogSettings(CONFIG, 'host', location)).toMatchObject({
      person_profiles: 'identified_only',
      capture_pageview: 'history_change',
      autocapture: false,
      disable_session_recording: true,
    });
  });
});

describe('scrubEvent', () => {
  const event = () => ({
    event: 'calendars_booking_page_viewed',
    properties: {
      $current_url: 'https://cal.example.test/acme/ana/intro?prefill=ana@example.com#x',
      $referrer: 'https://crm.example.test/contacts/42?email=ana@example.com',
    },
    $set_once: { $initial_current_url: 'https://cal.example.test/acme/ana?token=secret' },
  });

  it('strips every query and fragment; a visitor referrer keeps only its origin', () => {
    const out = scrubEvent(event(), 'visitor', '/acme/ana/intro')!;
    expect(out.properties!['$current_url']).toBe('https://cal.example.test/acme/ana/intro');
    expect(out.properties!['$referrer']).toBe('https://crm.example.test');
    expect(out.$set_once!['$initial_current_url']).toBe('https://cal.example.test/acme/ana');
    expect(JSON.stringify(out)).not.toContain('example.com');
  });

  it('a host referrer keeps its path, never its query', () => {
    const out = scrubEvent(event(), 'host', '/admin')!;
    expect(out.properties!['$referrer']).toBe('https://crm.example.test/contacts/42');
  });

  it('the host instance never speaks for a page outside the dashboard', () => {
    expect(scrubEvent(event(), 'host', '/acme/ana/intro')).toBeNull();
    expect(scrubEvent(event(), 'host', '/administrator')).toBeNull();
    expect(scrubEvent(event(), 'host', '/onboarding')).not.toBeNull();
    expect(scrubEvent(event(), 'host', '/admin/bookings/1')).not.toBeNull();
  });

  it('leaves the direct marker and non-URLs alone, and nulls a broken URL', () => {
    expect(withoutQuery('$direct', 'origin')).toBe('$direct');
    expect(withoutQuery(undefined, 'path')).toBeUndefined();
    expect(withoutQuery('not a url', 'path')).toBeNull();
  });
});

describe('connectPosthog', () => {
  it('installs the vendor loader stub as a queue, and asks the configured host for the library', () => {
    // jsdom does not run inline scripts, so run the stub the way a browser
    // would, against a window of its own.
    const own = { document, location: window.location } as unknown as Parameters<typeof connectPosthog>[2] & {
      posthog?: Record<string, unknown>;
    };
    const append = document.head.appendChild.bind(document.head);
    const spy = vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(node: T): T => {
      append(node);
      const el = node as unknown as HTMLScriptElement;
      if (el.tagName === 'SCRIPT' && !el.src) new Function('window', 'document', el.textContent ?? '')(own, document);
      return node;
    });
    try {
      const port = connectPosthog(CONFIG, 'visitor', own);
      expect(port).not.toBeNull();
      const global = own.posthog as unknown as Record<string, unknown> & { _i: unknown[][] };
      expect(global['__SV']).toBe(1);
      expect(global._i).toHaveLength(1);
      expect(global._i[0]![0]).toBe(CONFIG.key);
      expect(global._i[0]![1]).toMatchObject({ person_profiles: 'never', persistence: 'memory' });
      expect(global._i[0]![2]).toBe('calendars_visitor');
      const script = document.querySelector<HTMLScriptElement>('script[src$="/static/array.js"]');
      expect(script?.src).toBe(`${CONFIG.host}/static/array.js`);
      // Calls before the library loads wait in the stub's queue for this name.
      port!.capture('calendars_day_picked', { mode: 'personal' });
      expect(global['calendars_visitor']).toContainEqual(['capture', 'calendars_day_picked', { mode: 'personal' }]);
    } finally {
      spy.mockRestore();
    }
  });

  it('reports no port when the vendor global could not be installed', () => {
    // A document whose inline scripts never run, as under a strict policy.
    expect(connectPosthog(CONFIG, 'visitor')).toBeNull();
  });

  it('initializes each audience once, under its own name', () => {
    const vendor = loadedVendor();
    connectPosthog(CONFIG, 'host');
    connectPosthog(CONFIG, 'host');
    connectPosthog(CONFIG, 'visitor');
    expect(vendor.init.mock.calls.map((c) => c[2])).toEqual(['calendars_host', 'calendars_visitor']);
  });

  it('a visitor port can never identify, alias or group', () => {
    const vendor = loadedVendor();
    const port = connectPosthog(CONFIG, 'visitor')!;
    port.identify('ana@example.com', { email: 'ana@example.com' });
    port.alias('landing-id');
    port.group('calendars_account', 'acme');
    port.capture('calendars_booking_confirmed');
    expect(vendor.calls.map(([, method]) => method)).toEqual(['capture']);
  });

  it('a host port passes identity through', () => {
    const vendor = loadedVendor();
    const port = connectPosthog(CONFIG, 'host')!;
    port.identify('host@example.test', { role: 'owner' });
    port.alias('landing-id');
    port.group('calendars_account', 'acme');
    expect(vendor.calls).toEqual([
      ['calendars_host', 'identify', ['host@example.test', { role: 'owner' }]],
      ['calendars_host', 'alias', ['landing-id']],
      ['calendars_host', 'group', ['calendars_account', 'acme', undefined]],
    ]);
  });
});

describe('track', () => {
  it('is a no-op with no port, and prefixes the event when there is one', () => {
    expect(() => track('link_copied')).not.toThrow();
    const capture = vi.fn();
    const port = { surface: 'host', capture, reset: vi.fn() } as unknown as AnalyticsPort;
    setActiveAnalyticsPort(port);
    track('link_copied', { a: 1 });
    expect(capture).toHaveBeenCalledWith('calendars_link_copied', { a: 1 });
    clearActiveAnalyticsPort(port);
    track('link_copied');
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('never throws into a click, and only a host identity is reset', () => {
    const port = {
      surface: 'visitor',
      capture: () => {
        throw new Error('vendor broke');
      },
      reset: vi.fn(),
    } as unknown as AnalyticsPort;
    setActiveAnalyticsPort(port);
    expect(() => track('day_picked')).not.toThrow();
    resetAnalytics();
    expect(port.reset).not.toHaveBeenCalled();
    clearActiveAnalyticsPort(port);
  });
});
