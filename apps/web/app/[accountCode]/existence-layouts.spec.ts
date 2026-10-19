/**
 * The layouts that turn a dead public link into a real 404: they run above
 * every loading boundary, so `notFound()` from here lands before a status line
 * is sent. The status itself is proven end to end (e2e/api-public-surface);
 * these pin each layout's decision.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  getProfile: vi.fn(),
  getTeamProfile: vi.fn(),
  getOneOffLink: vi.fn(),
}));
vi.mock('@/lib/api', () => api);

const request = vi.hoisted(() => ({ path: null as string | null }));
vi.mock('next/headers', () => ({
  headers: async () => ({ get: (name: string) => (name === 'x-slate-path' ? request.path : null) }),
}));

class NotFound extends Error {}
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new NotFound('NEXT_HTTP_ERROR_FALLBACK;404');
  },
}));

import HostLayout from './[handle]/layout';
import TeamLayout from './team/[teamSlug]/layout';
import OneOffLinkLayout from '../booking/[token]/layout';

const CHILD = 'page';
const host = { eventTypes: [{ slug: 'intro-call' }] };
const team = { eventTypes: [{ slug: 'team-demo' }] };

beforeEach(() => {
  vi.clearAllMocks();
  request.path = null;
});

describe('HostLayout', () => {
  const render = () =>
    HostLayout({ children: CHILD, params: Promise.resolve({ accountCode: 'acme', handle: 'alex' }) });

  it('turns away a host that does not exist', async () => {
    api.getProfile.mockResolvedValue(null);
    request.path = '/acme/alex';
    await expect(render()).rejects.toBeInstanceOf(NotFound);
  });

  it('lets the profile and every listed event through', async () => {
    api.getProfile.mockResolvedValue(host);
    request.path = '/acme/alex';
    expect(await render()).toBe(CHILD);
    request.path = '/acme/alex/intro-call';
    expect(await render()).toBe(CHILD);
  });

  it('turns away an event the host does not list', async () => {
    api.getProfile.mockResolvedValue(host);
    request.path = '/acme/alex/no-such-event';
    await expect(render()).rejects.toBeInstanceOf(NotFound);
    request.path = '/acme/alex/%E0%A4%A';
    await expect(render()).rejects.toBeInstanceOf(NotFound);
  });

  it("leaves the event to its page when the path is unknown (the page's own check answers)", async () => {
    api.getProfile.mockResolvedValue(host);
    expect(await render()).toBe(CHILD);
  });
});

describe('TeamLayout', () => {
  const render = () =>
    TeamLayout({ children: CHILD, params: Promise.resolve({ accountCode: 'acme', teamSlug: 'sales' }) });

  it('turns away a team that does not exist', async () => {
    api.getTeamProfile.mockResolvedValue(null);
    request.path = '/acme/team/sales';
    await expect(render()).rejects.toBeInstanceOf(NotFound);
  });

  it('lets the landing and every listed event through, and turns away the rest', async () => {
    api.getTeamProfile.mockResolvedValue(team);
    request.path = '/acme/team/sales';
    expect(await render()).toBe(CHILD);
    request.path = '/acme/team/sales/team-demo';
    expect(await render()).toBe(CHILD);
    request.path = '/acme/team/sales/no-such-event';
    await expect(render()).rejects.toBeInstanceOf(NotFound);
  });
});

describe('OneOffLinkLayout', () => {
  const render = () => OneOffLinkLayout({ children: CHILD, params: Promise.resolve({ token: 'tok' }) });

  it('turns away a token that does not exist, like any other dead link', async () => {
    api.getOneOffLink.mockResolvedValue({ ok: false, reason: 'not-found' });
    await expect(render()).rejects.toBeInstanceOf(NotFound);
  });

  it('lets a live link and a used one through (the used one has its own page)', async () => {
    api.getOneOffLink.mockResolvedValue({ ok: true, target: {} });
    expect(await render()).toBe(CHILD);
    api.getOneOffLink.mockResolvedValue({ ok: false, reason: 'gone' });
    expect(await render()).toBe(CHILD);
  });
});
