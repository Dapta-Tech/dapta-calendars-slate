/**
 * The sign-in cookies carry the `__Host-` prefix in production, so a sibling
 * host on the same site cannot plant one the dashboard reads. A session from
 * before keeps working under its old name until its next write moves it over,
 * but only while no other host serves booking pages; the login's short-lived
 * cookies never take the old name. Writes force Secure, Path=/ and no Domain;
 * a removal clears both names. Outside production the plain names stay.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteHostCookie, hostCookieName, legacySessionReadable, readHostCookie, writeHostCookie } from '@/lib/session';

type Write = { name: string; value: string; options: Record<string, unknown> };

function jar(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const writes: Write[] = [];
  return {
    writes,
    store,
    get: (name: string) => (store.has(name) ? { value: store.get(name)! } : undefined),
    set: (name: string, value: string, options: Record<string, unknown>) => {
      writes.push({ name, value, options });
      if (options.maxAge === 0) store.delete(name);
      else store.set(name, value);
    },
  };
}

const OPTIONS = { httpOnly: true, sameSite: 'lax', secure: true, maxAge: 3600 };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('sign-in cookie names', () => {
  it('carry __Host- in production, and stay plain outside it', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(hostCookieName('slate_session')).toBe('__Host-slate_session');
    vi.stubEnv('NODE_ENV', 'test');
    expect(hostCookieName('slate_session')).toBe('slate_session');
  });

  it('read the __Host- name; the old one only for the session’s migration, and only while no __Host- cookie exists', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(readHostCookie(jar({ slate_session: 'old' }), 'slate_session', { legacy: true })).toBe('old');
    // Once the prefixed one exists, a plain cookie of the same name (one a
    // sibling host could have tossed) is never read.
    expect(readHostCookie(jar({ slate_session: 'tossed', '__Host-slate_session': 'mine' }), 'slate_session', { legacy: true })).toBe('mine');
    expect(readHostCookie(jar({}), 'slate_session', { legacy: true })).toBeUndefined();
    // The login's short-lived cookies never take the old name.
    expect(readHostCookie(jar({ slate_oauth_state: 'planted' }), 'slate_oauth_state')).toBeUndefined();
  });

  it('stop reading the old session name the moment another host serves booking pages', () => {
    expect(legacySessionReadable({ PUBLIC_APP_URL: 'https://app.example.com' })).toBe(true);
    expect(legacySessionReadable({ PUBLIC_APP_URL: 'https://app.example.com', PUBLIC_BOOKING_URL: 'https://app.example.com/' })).toBe(true);
    expect(legacySessionReadable({ PUBLIC_APP_URL: 'https://app.example.com', PUBLIC_BOOKING_URL: 'https://book.example.com' })).toBe(false);
    vi.stubEnv('NODE_ENV', 'production');
    // A signed-out visitor carrying a plain cookie planted from the booking host stays signed out.
    expect(readHostCookie(jar({ slate_session: 'planted' }), 'slate_session', { legacy: false })).toBeUndefined();
  });

  it('write under the __Host- name, Path=/ and no Domain, and retire the old name', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const j = jar({ slate_session: 'old' });
    writeHostCookie(j, 'slate_session', 'fresh', { ...OPTIONS, secure: false, path: '/admin', domain: 'example.com' });
    expect(j.store.get('__Host-slate_session')).toBe('fresh');
    expect(j.store.has('slate_session')).toBe(false);
    // Secure, Path=/ and no Domain, whatever the caller passed.
    expect(j.writes[0]!.options).toMatchObject({ path: '/', domain: undefined, secure: true });
    expect(j.writes[1]!.options).toMatchObject({ path: '/', domain: undefined, maxAge: 0 });
  });

  it('remove both names with an expired write that keeps Secure and Path=/', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const j = jar({ slate_session: 'old', '__Host-slate_session': 'mine' });
    deleteHostCookie(j, 'slate_session', OPTIONS);
    expect(j.store.size).toBe(0);
    expect(j.writes.find((w) => w.name === '__Host-slate_session')!.options).toMatchObject({ maxAge: 0, secure: true, path: '/' });
  });

  it('outside production, read, write and remove the plain name only', () => {
    vi.stubEnv('NODE_ENV', 'test');
    const j = jar({ slate_session: 'old' });
    expect(readHostCookie(j, 'slate_session', { legacy: true })).toBe('old');
    expect(readHostCookie(j, 'slate_session')).toBe('old');
    writeHostCookie(j, 'slate_session', 'fresh', { ...OPTIONS, secure: false });
    expect([...j.store.keys()]).toEqual(['slate_session']);
    deleteHostCookie(j, 'slate_session', { ...OPTIONS, secure: false });
    expect(j.store.size).toBe(0);
  });
});
