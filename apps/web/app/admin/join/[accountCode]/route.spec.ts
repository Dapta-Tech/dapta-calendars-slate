import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { WorkspaceView } from '@slate/types';

const getSession = vi.fn();
const hostFetch = vi.fn();
vi.mock('@/lib/auth-session', () => ({
  getSession: () => getSession(),
  hostFetch: (...args: unknown[]) => hostFetch(...args),
}));
const setWorkspace = vi.fn();
const clearWorkspace = vi.fn();
vi.mock('@/lib/workspace', () => ({
  setWorkspace: (id: string) => setWorkspace(id),
  clearWorkspace: () => clearWorkspace(),
}));

import { GET } from './route';
import { GET as inviteLink } from '../../../invite/[accountCode]/route';

const ws = (over: Partial<WorkspaceView>): WorkspaceView => ({
  accountId: 'acct_x',
  accountCode: 'xxxxxx',
  accountName: 'X',
  role: 'member',
  status: 'active',
  current: false,
  home: false,
  ...over,
});
const LIST: WorkspaceView[] = [
  ws({ accountId: 'acct_pablo', accountCode: 'pab123', accountName: 'Pablo', role: 'owner', current: true, home: true }),
  ws({ accountId: 'acct_alejandro', accountCode: 'dasri5', accountName: 'Alejandro', status: 'invited' }),
];

const call = (code: string) =>
  GET(new NextRequest(`https://calendar.example.com/admin/join/${code}`), { params: Promise.resolve({ accountCode: code }) });
const location = (res: Response) => new URL(res.headers.get('location')!).pathname + new URL(res.headers.get('location')!).search;

describe('joining from the invitation link', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSession.mockResolvedValue({ provider: 'local', email: 'pablo@acme.test' });
    hostFetch.mockResolvedValue(new Response(JSON.stringify(LIST), { status: 200 }));
  });

  it('the email link hands over to the dashboard path', async () => {
    const res = await inviteLink(new NextRequest('https://calendar.example.com/invite/DASRI5'), {
      params: Promise.resolve({ accountCode: 'DASRI5' }),
    });
    expect(location(res)).toBe('/admin/join/dasri5');
  });

  it('signed out: through the login and back here', async () => {
    getSession.mockResolvedValue(null);
    const res = await call('dasri5');
    expect(location(res)).toBe('/login?next=%2Fadmin%2Fjoin%2Fdasri5');
    expect(hostFetch).not.toHaveBeenCalled();
  });

  it('opens the invited workspace, asking the API as the person (no workspace header)', async () => {
    const res = await call('dasri5');
    expect(hostFetch).toHaveBeenCalledWith('/v1/me/workspaces', undefined, { workspace: false });
    expect(setWorkspace).toHaveBeenCalledWith('acct_alejandro');
    expect(location(res)).toBe('/admin');
  });

  it('the own account is no choice at all: the cookie goes', async () => {
    await call('pab123');
    expect(clearWorkspace).toHaveBeenCalled();
    expect(setWorkspace).not.toHaveBeenCalled();
  });

  it('an invitation that is not theirs, or a code that is no workspace, reads the same', async () => {
    expect(location(await call('zzzzzz'))).toBe('/invite/not-for-you?code=zzzzzz');
    expect(setWorkspace).not.toHaveBeenCalled();
  });

  it('a malformed code goes nowhere but the dashboard', async () => {
    expect(location(await call('..%2F..'))).toBe('/admin');
    expect(hostFetch).not.toHaveBeenCalled();
  });
});
