import { beforeEach, describe, expect, it, vi } from 'vitest';

const acceptWorkspace = vi.fn();
vi.mock('@/lib/admin-api', () => ({ adminApi: { acceptWorkspace: (id: string) => acceptWorkspace(id) } }));
const setWorkspace = vi.fn();
const clearWorkspace = vi.fn();
vi.mock('@/lib/workspace', () => ({
  setWorkspace: (id: string) => setWorkspace(id),
  clearWorkspace: () => clearWorkspace(),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  },
  unstable_rethrow: (e: unknown) => {
    if (e instanceof Error && e.message.startsWith('NEXT_REDIRECT')) throw e;
  },
}));

import { acceptInviteAction } from './actions';

const form = (accountId: string) => {
  const f = new FormData();
  f.set('accountId', accountId);
  return f;
};

describe('the Join button', () => {
  beforeEach(() => vi.clearAllMocks());

  it('accepts, opens the workspace and lands on the dashboard', async () => {
    acceptWorkspace.mockResolvedValue({ accountId: 'acct_alejandro', home: false, status: 'active' });
    await expect(acceptInviteAction(null, form('acct_alejandro'))).rejects.toThrow('NEXT_REDIRECT:/admin');
    expect(acceptWorkspace).toHaveBeenCalledWith('acct_alejandro');
    expect(setWorkspace).toHaveBeenCalledWith('acct_alejandro');
  });

  it('opens nothing when the API refuses (no invitation for this person)', async () => {
    acceptWorkspace.mockRejectedValue(new Error('404'));
    expect(await acceptInviteAction(null, form('acct_other'))).toEqual({ error: true });
    expect(setWorkspace).not.toHaveBeenCalled();
    expect(await acceptInviteAction(null, form(''))).toEqual({ error: true });
  });
});
