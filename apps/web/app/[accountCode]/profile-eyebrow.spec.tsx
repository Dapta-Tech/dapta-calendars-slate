/**
 * The quiet line over a profile's heading is the account's (workspace's) name.
 * It says something when it differs from the heading ("Northwind Studio" over
 * "Riley Chen") and nothing when it repeats it: a one-person workspace is often
 * named after its owner, and the page read "Riley" over "Riley". The rule lives
 * in `ProfileView`, so the person profile, the team landing and the studio
 * preview (`preview-parity.spec.tsx`) all apply it.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

const api = vi.hoisted(() => ({ getProfile: vi.fn(), getTeamProfile: vi.fn() }));
vi.mock('@/lib/api', () => api);
vi.mock('@/lib/locale', () => ({ publicLocale: async () => 'en' }));
vi.mock('@/lib/theme.server', () => ({ resolveDocumentTheme: async () => 'dark' }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('notFound');
  },
  permanentRedirect: (to: string) => {
    throw new Error(`permanentRedirect ${to}`);
  },
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
}));

import ProfilePage from './[handle]/page';
import TeamPage from './team/[teamSlug]/page';
import { profileEyebrow } from '@/components/profile-view';
import { ACCOUNT, BASE_STYLE, TIME_ZONE, profile } from './__fixtures__/public-surface';

/** The line over the heading, or null when the page draws none. */
function eyebrowOf(html: string): string | null {
  const head = html.match(/<header class="bp-profile-head">([\s\S]*?)<\/header>/)?.[1] ?? '';
  return head.match(/<p class="bp-muted bp-small">([^<]*)<\/p>/)?.[1] ?? null;
}

const render = async (page: Promise<ReactElement>) => renderToStaticMarkup(await page);

describe('profileEyebrow', () => {
  it('keeps an account name that says something the heading does not', () => {
    expect(profileEyebrow('Northwind Studio', 'Riley Chen')).toBe('Northwind Studio');
    // A longer or shorter name is still information, not a repeat.
    expect(profileEyebrow('Riley', 'Riley Chen')).toBe('Riley');
    expect(profileEyebrow('Riley Chen Studio', 'Riley Chen')).toBe('Riley Chen Studio');
  });

  it('drops one that only repeats the heading, whatever its case, accents or spacing', () => {
    expect(profileEyebrow('Riley', 'Riley')).toBeNull();
    expect(profileEyebrow('riley chen', 'Riley Chen')).toBeNull();
    expect(profileEyebrow('  Riley   Chen ', 'Riley Chen')).toBeNull();
    expect(profileEyebrow('Andrés', 'Andres')).toBeNull();
    expect(profileEyebrow('ANDRES', 'Andrés')).toBeNull();
  });

  it('draws nothing for an absent or blank name', () => {
    expect(profileEyebrow(null, 'Riley Chen')).toBeNull();
    expect(profileEyebrow(undefined, 'Riley Chen')).toBeNull();
    expect(profileEyebrow('   ', 'Riley Chen')).toBeNull();
  });
});

describe('the person profile', () => {
  const page = () =>
    ProfilePage({
      params: Promise.resolve({ accountCode: ACCOUNT.code, handle: 'riley-chen' }),
      searchParams: Promise.resolve({}),
    });

  it('carries a company account over the host', async () => {
    api.getProfile.mockResolvedValue(profile(BASE_STYLE));
    expect(eyebrowOf(await render(page()))).toBe('Northwind Studio');
  });

  it('says the name once when the account is named after the host', async () => {
    const p = profile(BASE_STYLE);
    api.getProfile.mockResolvedValue({ ...p, account: { ...p.account, name: 'riley chen' } });
    const html = await render(page());
    expect(eyebrowOf(html)).toBeNull();
    expect(html).toContain('<h1 class="bp-profile-name">Riley Chen</h1>');
  });
});

describe('the team landing', () => {
  const team = (name: string) => ({
    account: ACCOUNT,
    team: { slug: 'studio', name, logoUrl: null, timeZone: TIME_ZONE },
    eventTypes: [{ slug: 'intro', title: 'Intro call', description: null, lengthMinutes: 15 }],
  });
  const page = () =>
    TeamPage({
      params: Promise.resolve({ accountCode: ACCOUNT.code, teamSlug: 'studio' }),
      searchParams: Promise.resolve({}),
    });

  it('carries the workspace over a team named otherwise', async () => {
    api.getTeamProfile.mockResolvedValue(team('Studio Team'));
    expect(eyebrowOf(await render(page()))).toBe('Northwind Studio');
  });

  it('says the name once when the team is named like its workspace', async () => {
    api.getTeamProfile.mockResolvedValue(team('Northwind Studio'));
    const html = await render(page());
    expect(eyebrowOf(html)).toBeNull();
    expect(html).toContain('<h1 class="bp-profile-name">Northwind Studio</h1>');
  });
});
