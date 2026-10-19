import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, membershipsBySubject, migrate, seed, sql, type Db } from '@slate/db';
import { loadServerEnv } from '@slate/config/env';
import { createAuthProvider, type ReqLike } from './auth.provider';
import { WorkOsAuthProvider } from './auth.provider.workos';
import { AuthService } from './auth.service';
import { signJwtHs256 } from './jwt';

const SECRET = 'workos-provider-test-secret';
const ISS = 'example-identity-service';
const AUD = 'calendar-platform';

function bearer(token: string): ReqLike {
  return { headers: { authorization: `Bearer ${token}` } };
}

function mint(claims: Record<string, unknown>): string {
  const nowSec = Math.floor(Date.now() / 1000);
  return signJwtHs256({ iss: ISS, aud: AUD, exp: nowSec + 3600, ...claims }, SECRET);
}

describe('WorkOsAuthProvider — validates the platform JWT and projects a principal', () => {
  let db: Db;
  const env = { JWT_SECRET: SECRET, JWT_ISSUER: ISS, JWT_AUDIENCE: AUD };

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
  });

  it('JIT-provisions an account + member on first login, keyed by claims', async () => {
    const provider = new WorkOsAuthProvider(db, env);
    const p = await provider.resolveHost(bearer(mint({ account_id: 'ext_acct_1', sub: 'ext_user_1', email: 'a@x.io', name: 'Ada' })));

    const acct = await db.get<{ id: string; external_id: string }>(
      sql`SELECT id, external_id FROM account WHERE external_id = 'ext_acct_1'`,
    );
    const mem = await db.get<{ id: string; email: string; external_id: string }>(
      sql`SELECT id, email, external_id FROM member WHERE external_id = 'ext_user_1'`,
    );
    expect(acct).toBeDefined();
    expect(mem).toBeDefined();
    expect(p.accountId).toBe(acct!.id);
    expect(p.memberId).toBe(mem!.id);
    expect(mem!.email).toBe('a@x.io');
  });

  it('a member provisioned on first login is born with the new booking page look', async () => {
    const provider = new WorkOsAuthProvider(db, env);
    const p = await provider.resolveHost(bearer(mint({ account_id: 'ext_acct_9', sub: 'ext_user_9', email: 'b@x.io', name: 'Bo' })));
    const row = await db.get<{ brand_color: string | null; booking_page_style: unknown }>(
      sql`SELECT brand_color, booking_page_style FROM member WHERE id = ${p.memberId}`,
    );
    expect(row!.brand_color).toBe('#1a1a1c');
    const style =
      typeof row!.booking_page_style === 'string'
        ? JSON.parse(row!.booking_page_style)
        : row!.booking_page_style;
    expect(style).toEqual({ theme: 'light' });
  });

  it('is idempotent — a second login resolves the SAME rows (no duplicates)', async () => {
    const provider = new WorkOsAuthProvider(db, env);
    const t = mint({ account_id: 'ext_acct_2', sub: 'ext_user_2' });
    const first = await provider.resolveHost(bearer(t));
    const second = await provider.resolveHost(bearer(t));
    expect(second).toEqual(first);

    const accounts = await db.all(sql`SELECT id FROM account WHERE external_id = 'ext_acct_2'`);
    const members = await db.all(sql`SELECT id FROM member WHERE external_id = 'ext_user_2'`);
    expect(accounts.length).toBe(1);
    expect(members.length).toBe(1);
  });

  it('two users in the same external account share one account, distinct members', async () => {
    const provider = new WorkOsAuthProvider(db, env);
    const a = await provider.resolveHost(bearer(mint({ account_id: 'ext_acct_3', sub: 'user_a' })));
    const b = await provider.resolveHost(bearer(mint({ account_id: 'ext_acct_3', sub: 'user_b' })));
    expect(a.accountId).toBe(b.accountId);
    expect(a.memberId).not.toBe(b.memberId);
  });

  it('rejects a missing bearer token (401)', async () => {
    const provider = new WorkOsAuthProvider(db, env);
    await expect(provider.resolveHost({ headers: {} })).rejects.toMatchObject({ status: 401 });
  });

  it('rejects a token signed with the wrong secret (401)', async () => {
    const provider = new WorkOsAuthProvider(db, env);
    const forged = signJwtHs256(
      { iss: ISS, aud: AUD, exp: Math.floor(Date.now() / 1000) + 3600, account_id: 'x', sub: 'y' },
      'not-the-secret',
    );
    await expect(provider.resolveHost(bearer(forged))).rejects.toMatchObject({ status: 401 });
  });

  it('rejects a token missing account_id / sub (401)', async () => {
    const provider = new WorkOsAuthProvider(db, env);
    await expect(provider.resolveHost(bearer(mint({ sub: 'only_sub' })))).rejects.toMatchObject({ status: 401 });
    await expect(provider.resolveHost(bearer(mint({ account_id: 'only_acct' })))).rejects.toMatchObject({ status: 401 });
  });

  // The trigger for the web's whole refresh contract: the platform token carries
  // a mandatory `exp`, so every session eventually hits this 401 in the ordinary
  // course of its life. `jwt.spec.ts` covers expiry at the verifier; this covers
  // it where the request path actually meets it.
  it('rejects a just-expired token (401) — the 401 the web answers by refreshing', async () => {
    const provider = new WorkOsAuthProvider(db, env);
    const nowSec = Math.floor(Date.now() / 1000);
    const expired = signJwtHs256(
      { iss: ISS, aud: AUD, exp: nowSec - 1, account_id: 'ext_acct_exp', sub: 'ext_user_exp' },
      SECRET,
    );
    await expect(provider.resolveHost(bearer(expired))).rejects.toMatchObject({ status: 401 });
  });

  it('rejects a wrong-issuer / wrong-audience token (401)', async () => {
    const provider = new WorkOsAuthProvider(db, env);
    const nowSec = Math.floor(Date.now() / 1000);
    const badIss = signJwtHs256({ iss: 'evil', aud: AUD, exp: nowSec + 3600, account_id: 'a', sub: 'b' }, SECRET);
    const badAud = signJwtHs256({ iss: ISS, aud: 'evil', exp: nowSec + 3600, account_id: 'a', sub: 'b' }, SECRET);
    await expect(provider.resolveHost(bearer(badIss))).rejects.toMatchObject({ status: 401 });
    await expect(provider.resolveHost(bearer(badAud))).rejects.toMatchObject({ status: 401 });
  });
});

// The role a JIT member arrives with decides what they can see, and `member`
// sees only its own resources — which for someone sent in to configure an
// account means an empty one. OPERATOR_EMAIL_DOMAIN is how a deployment names
// its own staff; a fork that sets nothing keeps the plain rule.
describe('WorkOsAuthProvider — the role a JIT member arrives with', () => {
  let db: Db;
  const base = { JWT_SECRET: SECRET, JWT_ISSUER: ISS, JWT_AUDIENCE: AUD };

  const roleOf = async (memberId: string): Promise<string | undefined> =>
    (await db.get<{ role: string }>(sql`SELECT role FROM member WHERE id = ${memberId}`))?.role;

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
  });

  it('still makes the first member of an account its owner, operator or not', async () => {
    const provider = new WorkOsAuthProvider(db, { ...base, OPERATOR_EMAIL_DOMAIN: '@operator.example' });
    const p = await provider.resolveHost(
      bearer(mint({ account_id: 'acct_first', sub: 'u_first', email: 'staff@operator.example' })),
    );
    expect(await roleOf(p.memberId)).toBe('owner');
  });

  it('gives operator staff admin when they arrive in an account someone else owns', async () => {
    const provider = new WorkOsAuthProvider(db, { ...base, OPERATOR_EMAIL_DOMAIN: '@operator.example' });
    await provider.resolveHost(bearer(mint({ account_id: 'acct_cust', sub: 'u_owner', email: 'owner@customer.io' })));
    const staff = await provider.resolveHost(
      bearer(mint({ account_id: 'acct_cust', sub: 'u_staff', email: 'Impl@Operator.Example' })),
    );
    expect(await roleOf(staff.memberId)).toBe('admin');
  });

  it('is not fooled by a domain that merely ends the same way', async () => {
    const provider = new WorkOsAuthProvider(db, { ...base, OPERATOR_EMAIL_DOMAIN: '@operator.example' });
    await provider.resolveHost(bearer(mint({ account_id: 'acct_near', sub: 'u_owner', email: 'owner@customer.io' })));
    const impostor = await provider.resolveHost(
      bearer(mint({ account_id: 'acct_near', sub: 'u_evil', email: 'evil@notoperator.example' })),
    );
    expect(await roleOf(impostor.memberId)).toBe('member');
  });

  it('leaves a bare fork untouched — no domain configured, nobody is special', async () => {
    const provider = new WorkOsAuthProvider(db, base);
    await provider.resolveHost(bearer(mint({ account_id: 'acct_bare', sub: 'u_owner', email: 'owner@customer.io' })));
    const later = await provider.resolveHost(
      bearer(mint({ account_id: 'acct_bare', sub: 'u_later', email: 'anyone@operator.example' })),
    );
    expect(await roleOf(later.memberId)).toBe('member');
  });
});

// What lets an MCP sign-in find the member: the platform JWT's
// `workos_user_id`, recorded on the member at web login.
describe('WorkOsAuthProvider: records the sign-in subject on the member', () => {
  let db: Db;
  const env = { JWT_SECRET: SECRET, JWT_ISSUER: ISS, JWT_AUDIENCE: AUD };

  const subjectOf = async (memberId: string) =>
    (await db.get<{ idp_subject: string | null }>(sql`SELECT idp_subject FROM member WHERE id = ${memberId}`))?.idp_subject;

  function provider() {
    const p = new WorkOsAuthProvider(db, env);
    const lines: Record<string, unknown>[] = [];
    p.auditSink = (line) => lines.push(JSON.parse(line) as Record<string, unknown>);
    return { p, lines };
  }

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
  });

  it('records it on the first login, once, with an audit line, and counts the login as seen', async () => {
    const { p, lines } = provider();
    const t = mint({ account_id: 'acct_s1', sub: 'iam_1', workos_user_id: 'user_01ALPHA' });
    const who = await p.resolveHost(bearer(t));
    expect(await subjectOf(who.memberId)).toBe('user_01ALPHA');
    const seen = (await db.get<{ login_seen_at: number | null }>(sql`SELECT login_seen_at FROM member WHERE id = ${who.memberId}`))!.login_seen_at;
    expect(Number(seen)).toBeGreaterThan(Date.now() - 60_000);
    await p.resolveHost(bearer(t));
    expect(lines).toEqual([expect.objectContaining({ msg: 'auth.idp_subject_recorded', accountId: who.accountId, memberId: who.memberId, takenFrom: [] })]);
    expect(JSON.stringify(lines)).not.toContain('user_01ALPHA');
  });

  it('rewrites it when the login carries a different one', async () => {
    const { p } = provider();
    const who = await p.resolveHost(bearer(mint({ account_id: 'acct_s2', sub: 'iam_2', workos_user_id: 'user_01OLD' })));
    await p.resolveHost(bearer(mint({ account_id: 'acct_s2', sub: 'iam_2', workos_user_id: 'user_01NEW' })));
    expect(await subjectOf(who.memberId)).toBe('user_01NEW');
  });

  it('records it when a login adopts an invite', async () => {
    const { p } = provider();
    const owner = await p.resolveHost(bearer(mint({ account_id: 'acct_inv', sub: 'iam_owner', email: 'owner@x.io' })));
    await db.run(
      sql`INSERT INTO member (id, account_id, email, handle, role, status, created_at)
          VALUES ('invited-1', ${owner.accountId}, 'guest@x.io', 'guest', 'admin', 'invited', ${Date.now()})`,
    );
    const guest = await p.resolveHost(bearer(mint({ account_id: 'acct_inv', sub: 'iam_guest', email: 'guest@x.io', workos_user_id: 'user_01GUEST' })));
    expect(guest.memberId).toBe('invited-1');
    expect(await subjectOf('invited-1')).toBe('user_01GUEST');
  });

  it('two members of one account with the same subject: the latest web login takes it', async () => {
    const { p, lines } = provider();
    const first = await p.resolveHost(bearer(mint({ account_id: 'acct_two', sub: 'iam_a', workos_user_id: 'user_01SHARED' })));
    const second = await p.resolveHost(bearer(mint({ account_id: 'acct_two', sub: 'iam_b', workos_user_id: 'user_01SHARED' })));
    expect(await subjectOf(first.memberId)).toBeNull();
    expect(await subjectOf(second.memberId)).toBe('user_01SHARED');
    expect(lines.at(-1)).toMatchObject({ memberId: second.memberId, takenFrom: [first.memberId] });
    // And back again on the first one's next login.
    await p.resolveHost(bearer(mint({ account_id: 'acct_two', sub: 'iam_a', workos_user_id: 'user_01SHARED' })));
    expect(await subjectOf(first.memberId)).toBe('user_01SHARED');
    expect(await subjectOf(second.memberId)).toBeNull();
  });

  it('leaves the member alone when the login carries none (a login that did not come through WorkOS)', async () => {
    const { p, lines } = provider();
    const who = await p.resolveHost(bearer(mint({ account_id: 'acct_none', sub: 'iam_none', workos_user_id: 'user_01KEEP' })));
    await p.resolveHost(bearer(mint({ account_id: 'acct_none', sub: 'iam_none' })));
    expect(await subjectOf(who.memberId)).toBe('user_01KEEP');
    expect(lines).toHaveLength(1);
  });

  it('stamps the link as of the token issue time: a 40-day-old token links nothing usable', async () => {
    const auth = new AuthService(db, new WorkOsAuthProvider(db, env));
    const iat = Math.floor(Date.now() / 1000) - 40 * 86_400;
    const who = await auth.resolveHost(bearer(mint({ account_id: 'acct_old', sub: 'iam_old', workos_user_id: 'user_01OLD40', iat })));
    expect(who.authenticatedAt).toBe(iat * 1000);
    const seen = (await db.get<{ login_seen_at: number | null }>(sql`SELECT login_seen_at FROM member WHERE id = ${who.memberId}`))!.login_seen_at;
    expect(Number(seen)).toBe(iat * 1000);
    expect(await membershipsBySubject(db, 'user_01OLD40', Date.now() - 30 * 86_400_000)).toEqual([]);
    // A token minted now makes the same link usable.
    await auth.resolveHost(bearer(mint({ account_id: 'acct_old', sub: 'iam_old', workos_user_id: 'user_01OLD40', iat: Math.floor(Date.now() / 1000) })));
    expect(await membershipsBySubject(db, 'user_01OLD40', Date.now() - 30 * 86_400_000)).toHaveLength(1);
  });

  it('an account reached by switching (no workos_user_id in its session) is reached through the first account\'s link', async () => {
    const auth = new AuthService(db, new WorkOsAuthProvider(db, env));
    // The first login carries the WorkOS user id; the switched-to account's session does not.
    const first = await auth.resolveHost(bearer(mint({ account_id: 'acct_primary', sub: 'iam_person', workos_user_id: 'user_01PERSON' })));
    const second = await auth.resolveHost(bearer(mint({ account_id: 'acct_switched', sub: 'iam_person' })));
    expect(await subjectOf(second.memberId)).toBeNull();
    // Both are owners (the first member of each account), both seen just now.
    const reached = await membershipsBySubject(db, 'user_01PERSON', Date.now() - 30 * 86_400_000);
    expect(reached.map((m) => m.memberId).sort()).toEqual([first.memberId, second.memberId].sort());
    expect(reached.every((m) => m.role === 'owner' && m.status === 'active')).toBe(true);
  });

  it('a failed write never costs the login', async () => {
    const broken = {
      ...db,
      sqlite: {
        ...db.sqlite!,
        txn: () => {
          throw Object.assign(new Error('boom'), { code: 'SQLITE_BUSY' });
        },
      },
    } as Db;
    const p = new WorkOsAuthProvider(broken, env);
    const who = await p.resolveHost(bearer(mint({ account_id: 'acct_fail', sub: 'iam_fail', workos_user_id: 'user_01FAIL' })));
    expect(who.memberId).toBeTruthy();
    expect(await subjectOf(who.memberId)).toBeNull();
  });
});

describe('createAuthProvider — workos wiring stays fail-loud without a secret', () => {
  it('throws for workos when JWT_SECRET is absent (never silent stub fallback)', async () => {
    const db = await createDb('file::memory:');
    expect(() => createAuthProvider(loadServerEnv({ AUTH_PROVIDER: 'workos' }), db)).toThrow(/workos|JWT_SECRET/i);
  });

  it('returns the WorkOsAuthProvider when JWT_SECRET is set', async () => {
    const db = await createDb('file::memory:');
    const provider = createAuthProvider(
      loadServerEnv({ AUTH_PROVIDER: 'workos', JWT_SECRET: SECRET, JWT_ISSUER: ISS, JWT_AUDIENCE: AUD }),
      db,
    );
    expect(provider.name).toBe('workos');
  });
});
