/**
 * MCP, Connect and keys hands the guide the skill's availability from the
 * same place the download route reads it: the API's public origin in the
 * runtime environment. Read here off the element the page returns, with the
 * API calls and the panels stubbed out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

vi.mock('@/lib/admin-api', () => ({
  adminApi: {
    listApiKeys: async () => [],
    listEventTypes: async () => [],
    listTeams: async () => [],
    teamEventTypes: async () => [],
    connectedApps: async () => ({ enabled: false, accessTokenTtlSeconds: null, grants: [] }),
  },
}));
vi.mock('../developer-page', () => ({
  developerAccess: async () => ({ locale: 'en', allowed: true }),
  DeveloperPage: () => null,
  DeveloperNoAccess: () => null,
}));
vi.mock('../keys-panel', () => ({ KeysPanel: () => null }));
vi.mock('../connected-apps', () => ({ ConnectedApps: () => null }));

import { KeysPanel } from '../keys-panel';
import DeveloperKeysPage from './page';

/** The props the page gives the keys panel. */
async function panelProps(): Promise<{ skillAvailable: boolean; snippets: unknown }> {
  const page = (await DeveloperKeysPage()) as ReactElement<{ children: ReactElement[] }>;
  const panel = [page.props.children].flat().find((child) => child?.type === KeysPanel)!;
  return panel.props as { skillAvailable: boolean; snippets: unknown };
}

describe('MCP, Connect and keys page', () => {
  beforeEach(() => {
    vi.stubEnv('MCP_PUBLIC_URL', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('offers the skill when the installation has a public API address', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('API_PUBLIC_URL', 'https://api.calendar.example.com');
    expect((await panelProps()).skillAvailable).toBe(true);
  });

  it('does not, when a production installation has none', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('API_PUBLIC_URL', '');
    const props = await panelProps();
    expect(props.skillAvailable).toBe(false);
    // The same verdict the MCP snippets get, from the same reading.
    expect(props.snippets).toBeNull();
  });
});
