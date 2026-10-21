import { beforeEach, describe, expect, it, vi } from 'vitest';

// A jar that answers per cookie name, so the session and the workspace choice
// are two different cookies, as in a browser. A cookie set with maxAge 0 is
// gone, as a browser drops it. `writable: false` is a render, where Next throws.
const store = new Map<string, string>();
let writable = true;
const cookieJar = {
  get: vi.fn((name: string) => (store.has(name) ? { name, value: store.get(name)! } : undefined)),
  set: vi.fn((name: string, value: string, opts?: { maxAge?: number }) => {
    if (!writable) throw new Error('Cookies can only be modified in a Server Action or Route Handler.');
    if (opts?.maxAge === 0) store.delete(name);
    else store.set(name, value);
  }),
  delete: vi.fn((name: string) => {
    if (!writable) throw new Error('Cookies can only be modified in a Server Action or Route Handler.');
    store.delete(name);
  }),
};
let pagePath: string | null = null;
vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => cookieJar),
  headers: async () => ({ get: (name: string) => (name === 'x-slate-path' ? pagePath : null) }),
}));
const redirect = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});
vi.mock('next/navigation', () => ({ redirect: (url: string) => redirect(url) }));

import { clearSession, encodeSession, hostHeaders, leaveForbiddenWorkspace } from './auth-session';
import { SESSION_COOKIE } from './session';
import { PATH_HEADER } from './theme';
import { WORKSPACE_COOKIE, setWorkspace } from './workspace';

const refused = (error = 'WORKSPACE_FORBIDDEN') =>
  new Response(JSON.stringify({ error, message: 'nope' }), { status: 403, headers: { 'content-type': 'application/json' } });

describe('the chosen workspace on host calls', () => {
  beforeEach(() => {
    store.clear();
    writable = true;
    pagePath = null;
    vi.clearAllMocks();
    vi.stubEnv('AUTH_PROVIDER', 'local');
    store.set(SESSION_COOKIE, encodeSession({ provider: 'local', email: 'pablo@acme.test' }));
  });

  it('reads the path header the middleware stamps', () => {
    expect(PATH_HEADER).toBe('x-slate-path');
  });

  it('sends only the identity when no workspace is chosen (as before workspaces existed)', async () => {
    expect(await hostHeaders()).toEqual({ 'x-slate-email': 'pablo@acme.test' });
  });

  it('names the chosen workspace, unless the caller asks to speak for the person', async () => {
    await setWorkspace('acct_alejandro');
    expect(cookieJar.set).toHaveBeenCalledWith(WORKSPACE_COOKIE, 'acct_alejandro', expect.objectContaining({ httpOnly: true, sameSite: 'lax', path: '/' }));
    expect(await hostHeaders()).toEqual({ 'x-slate-email': 'pablo@acme.test', 'x-dcal-workspace': 'acct_alejandro' });
    expect(await hostHeaders({ workspace: false })).toEqual({ 'x-slate-email': 'pablo@acme.test' });
  });

  it('names no workspace for a signed-out caller', async () => {
    store.clear();
    store.set(WORKSPACE_COOKIE, 'acct_alejandro');
    expect(await hostHeaders()).toEqual({});
  });

  it('where cookies can be written, drops a refused workspace at once and returns to the page', async () => {
    store.set(WORKSPACE_COOKIE, 'acct_gone');
    pagePath = '/admin/settings/members';
    await expect(leaveForbiddenWorkspace(refused())).rejects.toThrow('NEXT_REDIRECT:/admin/settings/members');
    expect(store.has(WORKSPACE_COOKIE)).toBe(false);
  });

  it('a pending invitation counts as a refusal too', async () => {
    store.set(WORKSPACE_COOKIE, 'acct_pending');
    await expect(leaveForbiddenWorkspace(refused('INVITATION_PENDING'))).rejects.toThrow('NEXT_REDIRECT:/admin');
    expect(store.has(WORKSPACE_COOKIE)).toBe(false);
  });

  it('a render hands over to the reset route, naming the refused workspace and the page', async () => {
    store.set(WORKSPACE_COOKIE, 'acct_gone');
    pagePath = '/admin/bookings';
    writable = false;
    await expect(leaveForbiddenWorkspace(refused())).rejects.toThrow(
      'NEXT_REDIRECT:/api/workspace/reset?w=acct_gone&next=%2Fadmin%2Fbookings',
    );
    expect(store.get(WORKSPACE_COOKIE)).toBe('acct_gone');
  });

  it('ignores every other 403, and any 403 when no workspace was chosen', async () => {
    store.set(WORKSPACE_COOKIE, 'acct_alejandro');
    await expect(leaveForbiddenWorkspace(refused('FORBIDDEN'))).resolves.toBeUndefined();
    await expect(leaveForbiddenWorkspace(new Response('{}', { status: 200 }))).resolves.toBeUndefined();
    store.delete(WORKSPACE_COOKIE);
    await expect(leaveForbiddenWorkspace(refused())).resolves.toBeUndefined();
    expect(redirect).not.toHaveBeenCalled();
  });

  it('drops the choice with the session, so the next person starts in their own account', async () => {
    store.set(WORKSPACE_COOKIE, 'acct_alejandro');
    await clearSession();
    expect(store.has(SESSION_COOKIE)).toBe(false);
    expect(store.has(WORKSPACE_COOKIE)).toBe(false);
  });
});
