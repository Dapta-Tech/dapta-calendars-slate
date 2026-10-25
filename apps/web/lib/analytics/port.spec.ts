// @vitest-environment jsdom
/**
 * `captureError`, the one way an error boundary reports: which audience a
 * page belongs to, what is never sent from the browser (an error the server
 * already reported, a page that belongs to no audience), and that an audience
 * the failed page never connected is connected for the report.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnalyticsConfig } from '@slate/shared';
import {
  analyticsSurfaceOf,
  captureError,
  clearActiveAnalyticsPort,
  resetAnalyticsPortsForTests,
  setActiveAnalyticsPort,
  setErrorAnalyticsConfig,
  type AnalyticsPort,
  type AnalyticsSurface,
} from './port';

const connectAnalytics = vi.hoisted(() => vi.fn());
vi.mock('./connect', () => ({ connectAnalytics }));

const CONFIG: AnalyticsConfig = { provider: 'posthog', key: 'phc_test', host: 'https://ingest.example.test', errors: true };

function fakePort(surface: AnalyticsSurface) {
  return {
    surface,
    capture: vi.fn(),
    identify: vi.fn(),
    alias: vi.fn(),
    register: vi.fn(),
    group: vi.fn(),
    reset: vi.fn(),
    captureError: vi.fn(),
  } satisfies AnalyticsPort;
}

const at = (path: string) => window.history.pushState({}, '', path);
const turn = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  resetAnalyticsPortsForTests();
  connectAnalytics.mockReset();
  at('/');
});

describe('analyticsSurfaceOf', () => {
  it('the dashboard and wizard are the host; booking pages are the visitor; the rest is nobody', () => {
    const cases: Array<[string, AnalyticsSurface | null]> = [
      ['/admin', 'host'],
      ['/admin/bookings/uid-1', 'host'],
      ['/onboarding', 'host'],
      ['/acme/ana', 'visitor'],
      ['/acme/ana/intro', 'visitor'],
      ['/acme/team/sales/demo', 'visitor'],
      ['/', null],
      ['/acme', null],
      ['/login', null],
      ['/auth/join', null],
      ['/manage/uid-1', null],
      ['/booking/one-off-token', null],
      ['/api/availability', null],
      ['/administrator/x', 'visitor'],
    ];
    for (const [path, surface] of cases) expect([path, analyticsSurfaceOf(path)]).toEqual([path, surface]);
  });
});

describe('captureError', () => {
  it("goes to the page's audience, tagged with the product and the boundary", () => {
    const port = fakePort('visitor');
    setActiveAnalyticsPort(port);
    at('/acme/ana/intro');
    const error = new Error('boom');
    captureError(error, 'booking_page');
    expect(port.captureError).toHaveBeenCalledWith(error, { product: 'calendars', error_boundary: 'booking_page' });
  });

  it('still reaches an audience whose loader unmounted (the boundary replaced the page)', () => {
    const port = fakePort('host');
    setActiveAnalyticsPort(port);
    clearActiveAnalyticsPort(port);
    at('/admin/bookings');
    captureError(new Error('boom'), 'dashboard');
    expect(port.captureError).toHaveBeenCalledTimes(1);
  });

  it('never sends an error the server already reported (it carries a digest)', () => {
    const port = fakePort('host');
    setActiveAnalyticsPort(port);
    at('/admin');
    captureError(Object.assign(new Error('An error occurred in the Server Components render.'), { digest: '123' }), 'dashboard');
    expect(port.captureError).not.toHaveBeenCalled();
  });

  it('sends nothing from a page that belongs to no audience', () => {
    const visitor = fakePort('visitor');
    const host = fakePort('host');
    setActiveAnalyticsPort(visitor);
    setActiveAnalyticsPort(host);
    setErrorAnalyticsConfig(CONFIG);
    for (const path of ['/login', '/manage/uid-1', '/booking/tok', '/']) {
      at(path);
      captureError(new Error(path), 'root');
    }
    expect(visitor.captureError).not.toHaveBeenCalled();
    expect(host.captureError).not.toHaveBeenCalled();
    expect(connectAnalytics).not.toHaveBeenCalled();
  });

  it('reports one error object once, however often the effect runs', () => {
    const port = fakePort('visitor');
    setActiveAnalyticsPort(port);
    at('/acme/ana');
    const error = new Error('boom');
    captureError(error, 'booking_page');
    captureError(error, 'booking_page');
    expect(port.captureError).toHaveBeenCalledTimes(1);
  });

  it('connects the audience a failed page never connected, when errors are on', async () => {
    const port = fakePort('visitor');
    connectAnalytics.mockReturnValue(port);
    setErrorAnalyticsConfig(CONFIG);
    at('/acme/ana/intro');
    const error = new Error('first paint failed');
    captureError(error, 'booking_page');
    await vi.waitFor(() => expect(port.captureError).toHaveBeenCalledWith(error, expect.objectContaining({ error_boundary: 'booking_page' })));
    expect(connectAnalytics).toHaveBeenCalledWith(CONFIG, 'visitor');
    // Connected once, then reused.
    captureError(new Error('again'), 'booking_page');
    expect(connectAnalytics).toHaveBeenCalledTimes(1);
    expect(port.captureError).toHaveBeenCalledTimes(2);
  });

  it('never connects a host audience itself (it would count a pageview and keep an id)', async () => {
    setErrorAnalyticsConfig(CONFIG);
    at('/onboarding');
    captureError(new Error('wizard failed first'), 'root');
    await turn();
    expect(connectAnalytics).not.toHaveBeenCalled();
  });

  it('an error that found no audience yet is not marked sent: a later report still goes', async () => {
    const error = new Error('early');
    at('/admin');
    captureError(error, 'dashboard');
    const port = fakePort('host');
    setActiveAnalyticsPort(port);
    captureError(error, 'dashboard');
    expect(port.captureError).toHaveBeenCalledTimes(1);
  });

  it('connects nothing with errors off or no settings', async () => {
    at('/acme/ana');
    captureError(new Error('a'), 'booking_page');
    setErrorAnalyticsConfig({ ...CONFIG, errors: false });
    captureError(new Error('b'), 'booking_page');
    await turn();
    expect(connectAnalytics).not.toHaveBeenCalled();
  });

  it('never throws into a boundary', async () => {
    const port = fakePort('host');
    port.captureError.mockImplementation(() => {
      throw new Error('vendor broke');
    });
    setActiveAnalyticsPort(port);
    at('/admin');
    expect(() => captureError(new Error('x'), 'dashboard')).not.toThrow();
    connectAnalytics.mockImplementation(() => {
      throw new Error('cannot connect');
    });
    setErrorAnalyticsConfig(CONFIG);
    at('/acme/ana');
    expect(() => captureError(new Error('y'), 'booking_page')).not.toThrow();
    await turn();
  });
});
