import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createDb, migrate, sql, type Db } from '@slate/db';
import { oauthAdapter, storageId } from './oauth.adapter';

/**
 * The adapter's own guarantees, on the race window oidc-provider cannot see:
 * it reads a token, checks `consumed`, then calls `consume`. Two requests can
 * both pass the check; the adapter must let exactly one through.
 */
describe('oauth adapter', () => {
  let db: Db;
  let now = 1_000_000;
  const revoked: string[] = [];
  const make = (graceMs: number) =>
    oauthAdapter(db, { refreshGraceMs: graceMs, dcrUnusedTtlMs: 86_400_000, now: () => now, onReuseRevoked: (_k, g) => revoked.push(g) });

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    revoked.length = 0;
    now = 1_000_000;
  });
  afterEach(async () => db.close());

  it('stores a bearer id hashed, without the value in the payload, and reads it back with it', async () => {
    const Adapter = make(0);
    const rt = new Adapter('RefreshToken');
    await new Adapter('Grant').upsert('g1', { accountId: 'm1', clientId: 'c1' }, 3600);
    await rt.upsert('secret-token-value', { jti: 'secret-token-value', grantId: 'g1', exp: 9_999_999_999 }, 3600);
    const row = (await db.get<{ id: string; payload: string }>(sql`SELECT id, payload FROM oauth_record WHERE kind = 'RefreshToken'`))!;
    expect(row.id).toBe(createHash('sha256').update('secret-token-value').digest('base64url'));
    expect(row.payload).not.toContain('secret-token-value');
    expect((await rt.find('secret-token-value'))?.jti).toBe('secret-token-value');
    expect(storageId('Grant', 'g1')).toBe('g1');
  });

  it('two consumers that both saw the token unspent: the second is refused and the grant revoked', async () => {
    const Adapter = make(0);
    const rt = new Adapter('RefreshToken');
    const grant = new Adapter('Grant');
    await grant.upsert('g1', { accountId: 'm1', clientId: 'c1' }, 3600);
    await rt.upsert('t1', { jti: 't1', grantId: 'g1' }, 3600);
    expect((await rt.find('t1'))?.consumed).toBeUndefined();
    expect((await rt.find('t1'))?.consumed).toBeUndefined();
    await rt.consume('t1');
    await expect(rt.consume('t1')).rejects.toMatchObject({ error: 'invalid_grant' });
    expect(revoked).toEqual(['g1']);
    expect(await grant.find('g1')).toBeUndefined();
    expect(await rt.find('t1')).toBeUndefined();
  });

  it('inside the retry grace a second consume of a refresh token passes; after it, reads as spent', async () => {
    const Adapter = make(10_000);
    const rt = new Adapter('RefreshToken');
    await new Adapter('Grant').upsert('g1', { accountId: 'm1', clientId: 'c1' }, 3600);
    await rt.upsert('t1', { jti: 't1', grantId: 'g1' }, 3600);
    await rt.consume('t1');
    now += 5_000;
    expect((await rt.find('t1'))?.consumed).toBeUndefined();
    await rt.consume('t1');
    now += 6_000;
    expect((await rt.find('t1'))?.consumed).toBe(Math.floor(1_000_000 / 1000));
    expect(revoked).toEqual([]);
  });

  it('destroying a refresh token (RFC 7009 revocation) revokes its grant: a grace-window sibling dies too', async () => {
    const Adapter = make(10_000);
    const rt = new Adapter('RefreshToken');
    const grant = new Adapter('Grant');
    await grant.upsert('g1', { accountId: 'm1', clientId: 'c1' }, 3600);
    await rt.upsert('old', { jti: 'old', grantId: 'g1' }, 3600);
    await rt.consume('old');
    await rt.upsert('new', { jti: 'new', grantId: 'g1' }, 3600);
    // Another connection of the same person stays untouched.
    await grant.upsert('g2', { accountId: 'm1', clientId: 'c2' }, 3600);
    await rt.upsert('other', { jti: 'other', grantId: 'g2' }, 3600);

    await rt.destroy('new');

    expect(await grant.find('g1')).toBeUndefined();
    expect(await rt.find('new')).toBeUndefined();
    expect(await rt.find('old')).toBeUndefined();
    expect((await rt.find('other'))?.grantId).toBe('g2');
    expect(await grant.find('g2')).toBeDefined();
  });

  it('destroying a kind that is not a refresh token removes only that record', async () => {
    const Adapter = make(0);
    const grant = new Adapter('Grant');
    const code = new Adapter('AuthorizationCode');
    await grant.upsert('g1', { accountId: 'm1', clientId: 'c1' }, 3600);
    await code.upsert('c1', { jti: 'c1', grantId: 'g1' }, 60);
    await code.destroy('c1');
    expect(await code.find('c1')).toBeUndefined();
    expect(await grant.find('g1')).toBeDefined();
  });

  it('an authorization code never gets a grace', async () => {
    const Adapter = make(10_000);
    const code = new Adapter('AuthorizationCode');
    await new Adapter('Grant').upsert('g2', { accountId: 'm1', clientId: 'c1' }, 3600);
    await code.upsert('c1', { jti: 'c1', grantId: 'g2' }, 60);
    await code.consume('c1');
    expect((await code.find('c1'))?.consumed).toBeTruthy();
    await expect(code.consume('c1')).rejects.toMatchObject({ error: 'invalid_grant' });
    expect(revoked).toEqual(['g2']);
  });

  it('refuses to store a refresh token or code for a grant that is gone, and leaves no row behind', async () => {
    const Adapter = make(0);
    const grant = new Adapter('Grant');
    const rt = new Adapter('RefreshToken');
    await grant.upsert('g3', { accountId: 'm1', clientId: 'c1' }, 3600);
    await rt.upsert('ok', { jti: 'ok', grantId: 'g3' }, 3600);
    expect(await rt.find('ok')).toBeTruthy();
    // A concurrent revocation lands between the winner's claim and its insert.
    await rt.revokeByGrantId('g3');
    await expect(rt.upsert('late', { jti: 'late', grantId: 'g3' }, 3600)).rejects.toMatchObject({ error: 'invalid_grant' });
    await expect(new Adapter('AuthorizationCode').upsert('late-code', { jti: 'late-code', grantId: 'g3' }, 60)).rejects.toMatchObject({ error: 'invalid_grant' });
    expect(await db.get(sql`SELECT id FROM oauth_record WHERE grant_id = 'g3'`)).toBeUndefined();
  });

  it('gives an unused dynamic registration a short life', async () => {
    const Adapter = make(0);
    await new Adapter('Client').upsert('client-1', { client_id: 'client-1' });
    const row = (await db.get<{ expires_at: number }>(sql`SELECT expires_at FROM oauth_record WHERE kind = 'Client'`))!;
    expect(Number(row.expires_at)).toBe(now + 86_400_000);
  });
});
