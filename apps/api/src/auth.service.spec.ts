import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, migrate, seed, sql, type Db } from '@slate/db';
import { LocalAuthProvider, type AuthProvider, type ResolvedHost } from './auth.provider';
import { AuthService, LOGIN_SEEN_REFRESH_MS, loginSeenRefreshMs } from './auth.service';
import { requestErrorContext } from './request-log';

/**
 * Every verified host request tells when a login last resolved the member
 * (`member.login_seen_at`, what an MCP sign-in through an external
 * authorization server is held to), for any provider, writing about once a day.
 */
describe('AuthService.resolveHost stamps the login, at most once a day', () => {
  let db: Db;
  let alex: { accountId: string; memberId: string };
  const seenAt = async () =>
    (await db.get<{ login_seen_at: number | null }>(sql`SELECT login_seen_at FROM member WHERE id = ${alex.memberId}`))!.login_seen_at;

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    const row = (await db.get<{ account_id: string; id: string }>(sql`SELECT account_id, id FROM member WHERE handle = 'alex-rivera'`))!;
    alex = { accountId: row.account_id, memberId: row.id };
  });

  const service = () => new AuthService(db, new LocalAuthProvider(db, { NODE_ENV: 'test', DEV_LOGIN_EMAIL: undefined, AUTH_LOCAL_STRICT: false }));
  const req = () => ({ headers: { 'x-slate-account': alex.accountId, 'x-slate-member': alex.memberId } });

  it('stamps a member never seen, then leaves it alone for a day, then stamps again', async () => {
    const auth = service();
    const t0 = Date.now();
    const spy = vi.spyOn(Date, 'now');
    spy.mockReturnValue(t0);
    expect((await auth.resolveHost(req())).role).toBe('owner');
    expect(Number(await seenAt())).toBe(t0);
    spy.mockReturnValue(t0 + LOGIN_SEEN_REFRESH_MS - 1);
    await auth.resolveHost(req());
    expect(Number(await seenAt())).toBe(t0);
    spy.mockReturnValue(t0 + LOGIN_SEEN_REFRESH_MS + 1);
    await auth.resolveHost(req());
    expect(Number(await seenAt())).toBe(t0 + LOGIN_SEEN_REFRESH_MS + 1);
    spy.mockRestore();
  });

  it('stamps when the identity service vouched (the token issue time), never the request time', async () => {
    const DAY = LOGIN_SEEN_REFRESH_MS;
    let issuedAt = Date.now() - 40 * DAY;
    const provider: AuthProvider = { name: 'fake', resolveHost: async (): Promise<ResolvedHost> => ({ ...alex, authenticatedAt: issuedAt }) };
    const auth = new AuthService(db, provider);
    await auth.resolveHost(req());
    expect(Number(await seenAt())).toBe(issuedAt);
    // The same old token used again and again: the stamp stays where it was.
    for (let i = 0; i < 3; i += 1) await auth.resolveHost(req());
    expect(Number(await seenAt())).toBe(issuedAt);
    // A token minted today moves it forward...
    const fresh = Date.now() - 1000;
    issuedAt = fresh;
    await auth.resolveHost(req());
    expect(Number(await seenAt())).toBe(fresh);
    // ...and an older one presented after it never moves it back.
    issuedAt = fresh - 5 * DAY;
    await auth.resolveHost(req());
    expect(Number(await seenAt())).toBe(fresh);
    // An issue time in the future counts as now.
    issuedAt = Date.now() + 10 * DAY;
    await db.run(sql`UPDATE member SET login_seen_at = NULL WHERE id = ${alex.memberId}`);
    await auth.resolveHost(req());
    expect(Number(await seenAt())).toBeLessThanOrEqual(Date.now());
  });

  it('a short link window shortens the refresh step, so a person signing in every 23 hours never falls out of a one-day window', async () => {
    expect(loginSeenRefreshMs(30)).toBe(LOGIN_SEEN_REFRESH_MS);
    expect(loginSeenRefreshMs(1)).toBe(LOGIN_SEEN_REFRESH_MS / 4);
    let issuedAt = Date.now() - 3 * 23 * 3_600_000;
    const provider: AuthProvider = { name: 'fake', resolveHost: async (): Promise<ResolvedHost> => ({ ...alex, authenticatedAt: issuedAt }) };
    const auth = new AuthService(db, provider, { OAUTH_LINK_MAX_AGE_DAYS: 1 });
    for (let i = 0; i < 3; i += 1) {
      await auth.resolveHost(req());
      expect(Number(await seenAt())).toBe(issuedAt);
      issuedAt += 23 * 3_600_000;
    }
  });

  it('a token that does not say when it was issued stamps nothing', async () => {
    await db.run(sql`UPDATE member SET login_seen_at = NULL WHERE id = ${alex.memberId}`);
    const provider: AuthProvider = { name: 'fake', resolveHost: async (): Promise<ResolvedHost> => ({ ...alex, authenticatedAt: null }) };
    await new AuthService(db, provider).resolveHost(req());
    expect(await seenAt()).toBeNull();
  });

  it('a failed stamp never costs the request', async () => {
    const auth = service();
    await db.run(sql`UPDATE member SET login_seen_at = NULL WHERE id = ${alex.memberId}`);
    const broken = new AuthService(
      { ...db, get: async (q: Parameters<Db['get']>[0]) => {
          const text = JSON.stringify(q);
          if (text.includes('UPDATE member SET login_seen_at')) throw new Error('database is locked');
          return db.get(q);
        } } as Db,
      new LocalAuthProvider(db, { NODE_ENV: 'test', DEV_LOGIN_EMAIL: undefined, AUTH_LOCAL_STRICT: false }),
    );
    expect((await broken.resolveHost(req())).memberId).toBe(alex.memberId);
    expect(await seenAt()).toBeNull();
    // The real one still stamps.
    await auth.resolveHost(req());
    expect(await seenAt()).not.toBeNull();
  });
});

/**
 * Error tracking may say whether a failed request came from one of the
 * operator's own people: the auth layer records that boolean on the request,
 * decided from the session's email, and never the email itself.
 */
describe('AuthService.resolveHost marks an internal host for error reports', () => {
  let db: Db;

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
  });

  const authWith = (patterns?: string) =>
    new AuthService(
      db,
      new LocalAuthProvider(db, { NODE_ENV: 'test', DEV_LOGIN_EMAIL: undefined, AUTH_LOCAL_STRICT: false }),
      { OAUTH_LINK_MAX_AGE_DAYS: 30, PRODUCT_ANALYTICS_INTERNAL_EMAILS: patterns },
    );

  it('records true for a matching email, false otherwise, and no email at all', async () => {
    const internal = { headers: { 'x-slate-email': 'jordan@example.com' } };
    await authWith('jordan@').resolveHost(internal);
    expect(requestErrorContext(internal)).toMatchObject({ is_internal: true });
    expect(JSON.stringify(requestErrorContext(internal))).not.toContain('jordan');

    const customer = { headers: { 'x-slate-email': 'alex@example.com' } };
    await authWith('jordan@').resolveHost(customer);
    expect(requestErrorContext(customer)).toMatchObject({ is_internal: false });

    const unset = { headers: { 'x-slate-email': 'jordan@example.com' } };
    await authWith(undefined).resolveHost(unset);
    expect(requestErrorContext(unset)).toMatchObject({ is_internal: false });
  });
});
