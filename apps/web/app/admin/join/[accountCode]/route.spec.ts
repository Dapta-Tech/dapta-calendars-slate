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
  ws({ accountId: 'acct_joined', accountCode: 'joined', accountName: 'Joined' }),
];

const call = (code: string) =>
  GET(new NextRequest(`https://calendar.example.com/admin/join/${code}`), { params: Promise.resolve({ accountCode: code }) });
const location = (res: Response) => {
  const url = new URL(res.headers.get('location')!);
  return url.pathname + url.search;
};

describe('the invitation link', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSession.mockResolvedValue({ provider: 'local', email: 'pablo@acme.test' });
    hostFetch.mockResolvedValue(new Response(JSON.stringify(LIST), { status: 200 }));
  });

  it('signed out: through the login and back here', async () => {
    getSession.mockResolvedValue(null);
    expect(location(await call('DASRI5'))).toBe('/login?next=%2Fauth%2Fjoin%3Fcode%3Ddasri5');
    expect(hostFetch).not.toHaveBeenCalled();
  });

  it('a pending invitation goes to the page that asks to Join: opening the link accepts nothing', async () => {
    expect(location(await call('dasri5'))).toBe('/auth/join?code=dasri5');
    expect(hostFetch).toHaveBeenCalledWith('/v1/me/workspaces', undefined, { workspace: false });
    expect(setWorkspace).not.toHaveBeenCalled();
  });

  it('a workspace the person already joined simply opens', async () => {
    expect(location(await call('joined'))).toBe('/admin');
    expect(setWorkspace).toHaveBeenCalledWith('acct_joined');
  });

  it('the own account is no choice at all: the cookie goes', async () => {
    await call('pab123');
    expect(clearWorkspace).toHaveBeenCalled();
    expect(setWorkspace).not.toHaveBeenCalled();
  });

  it('an invitation that is not theirs, or a code that is no workspace, reads the same', async () => {
    expect(location(await call('zzzzzz'))).toBe('/auth/join?code=zzzzzz');
    expect(setWorkspace).not.toHaveBeenCalled();
  });

  it('a malformed code goes nowhere but the dashboard', async () => {
    expect(location(await call('..%2F..'))).toBe('/admin');
    expect(hostFetch).not.toHaveBeenCalled();
  });
});
