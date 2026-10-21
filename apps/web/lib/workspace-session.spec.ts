import { beforeEach, describe, expect, it, vi } from 'vitest';

// A jar that answers per cookie name, so the session and the workspace choice
// are two different cookies, as in a browser.
const store = new Map<string, string>();
const cookieJar = {
  get: vi.fn((name: string) => (store.has(name) ? { name, value: store.get(name)! } : undefined)),
  set: vi.fn((name: string, value: string) => void store.set(name, value)),
  delete: vi.fn((name: string) => void store.delete(name)),
};
vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => cookieJar),
  headers: async () => ({ get: () => null }),
}));
const redirect = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});
vi.mock('next/navigation', () => ({ redirect: (url: string) => redirect(url) }));

import { clearSession, encodeSession, hostHeaders, leaveForbiddenWorkspace } from './auth-session';
import { SESSION_COOKIE } from './session';
import { WORKSPACE_COOKIE, WORKSPACE_RESET_PATH, setWorkspace } from './workspace';

const forbidden = (error = 'WORKSPACE_FORBIDDEN') =>
  new Response(JSON.stringify({ error, message: 'nope' }), { status: 403, headers: { 'content-type': 'application/json' } });

describe('the chosen workspace on host calls', () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
    vi.stubEnv('AUTH_PROVIDER', 'local');
    store.set(SESSION_COOKIE, encodeSession({ provider: 'local', email: 'pablo@acme.test' }));
  });

  it('sends only the identity when no workspace is chosen (as before workspaces existed)', async () => {
    expect(await hostHeaders()).toEqual({ 'x-slate-email': 'pablo@acme.test' });
  });

  it('names the chosen workspace, unless the caller asks to speak for the person', async () => {
    await setWorkspace('acct_alejandro');
    expect(cookieJar.set).toHaveBeenCalledWith(WORKSPACE_COOKIE, 'acct_alejandro', expect.objectContaining({ httpOnly: true, sameSite: 'lax' }));
    expect(await hostHeaders()).toEqual({ 'x-slate-email': 'pablo@acme.test', 'x-dcal-workspace': 'acct_alejandro' });
    expect(await hostHeaders({ workspace: false })).toEqual({ 'x-slate-email': 'pablo@acme.test' });
  });

  it('names no workspace for a signed-out caller', async () => {
    store.clear();
    store.set(WORKSPACE_COOKIE, 'acct_alejandro');
    expect(await hostHeaders()).toEqual({});
  });

  it('leaves a workspace the API refused through the reset route, never by retrying elsewhere', async () => {
    store.set(WORKSPACE_COOKIE, 'acct_gone');
    await expect(leaveForbiddenWorkspace(forbidden())).rejects.toThrow(`NEXT_REDIRECT:${WORKSPACE_RESET_PATH}`);
  });

  it('ignores every other 403, and any 403 when no workspace was chosen', async () => {
    store.set(WORKSPACE_COOKIE, 'acct_alejandro');
    await expect(leaveForbiddenWorkspace(forbidden('FORBIDDEN'))).resolves.toBeUndefined();
    await expect(leaveForbiddenWorkspace(new Response('{}', { status: 200 }))).resolves.toBeUndefined();
    store.delete(WORKSPACE_COOKIE);
    await expect(leaveForbiddenWorkspace(forbidden())).resolves.toBeUndefined();
    expect(redirect).not.toHaveBeenCalled();
  });

  it('drops the choice with the session, so the next person starts in their own account', async () => {
    store.set(WORKSPACE_COOKIE, 'acct_alejandro');
    await clearSession();
    expect(store.has(SESSION_COOKIE)).toBe(false);
    expect(store.has(WORKSPACE_COOKIE)).toBe(false);
  });
});
