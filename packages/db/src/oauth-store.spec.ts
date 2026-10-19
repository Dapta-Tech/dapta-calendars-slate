import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import { seed } from './seed';
import {
  claimOAuthRecord,
  consumeOAuthRecord,
  destroyOAuthRecord,
  extendOAuthRecordExpiry,
  findOAuthRecord,
  findOAuthRecordByUid,
  getOAuthSubject,
  listOAuthRecordsForAccount,
  liveOAuthRecordIds,
  purgeOAuthRecords,
  revokeOAuthGrant,
  takeOAuthRecord,
  upsertOAuthRecord,
} from './oauth-store';

/**
 * The OAuth artifact store, one contract run on both dialects: SQLite always,
 * real Postgres when DATABASE_URL names one (like every `.pg` spec, skipped on
 * the SQLite default). The cases that matter for security are the single-use
 * take, the first-consumption-wins rule and the grant-wide revoke; the
 * Postgres run also proves `bigint` columns come back as numbers.
 */
function oauthStoreContract(open: () => Promise<Db>, close: (db: Db) => Promise<void>) {
  let db: Db;
  const tag = () => randomUUID();

  beforeEach(async () => {
    db = await open();
  });
  afterEach(async () => {
    await close(db);
  });

  it('round-trips a payload and hides an expired row', async () => {
    const id = tag();
    await upsertOAuthRecord(db, { kind: 'Grant', id, payload: { accountId: 'm1', nested: { a: [1, 2] } }, expiresAt: Date.now() + 60_000 });
    const row = await findOAuthRecord(db, 'Grant', id);
    expect(row?.payload).toEqual({ accountId: 'm1', nested: { a: [1, 2] } });
    expect(typeof row?.expiresAt).toBe('number');

    const old = tag();
    await upsertOAuthRecord(db, { kind: 'Grant', id: old, payload: {}, expiresAt: Date.now() - 1 });
    expect(await findOAuthRecord(db, 'Grant', old)).toBeUndefined();
  });

  it('keys on (kind, id): the same id under two kinds is two rows', async () => {
    const id = tag();
    await upsertOAuthRecord(db, { kind: 'Grant', id, payload: { k: 'grant' }, grantId: id });
    await upsertOAuthRecord(db, { kind: 'GrantMeta', id, payload: { k: 'meta' }, grantId: id });
    expect((await findOAuthRecord(db, 'Grant', id))?.payload.k).toBe('grant');
    expect((await findOAuthRecord(db, 'GrantMeta', id))?.payload.k).toBe('meta');
  });

  it('finds by uid', async () => {
    const uid = tag();
    await upsertOAuthRecord(db, { kind: 'Session', id: tag(), payload: { uid }, uid });
    expect((await findOAuthRecordByUid(db, 'Session', uid))?.payload.uid).toBe(uid);
    expect(await findOAuthRecordByUid(db, 'Grant', uid)).toBeUndefined();
  });

  it('keeps the FIRST consumption time, and a replace keeps it too', async () => {
    const id = tag();
    await upsertOAuthRecord(db, { kind: 'RefreshToken', id, payload: { n: 1 } });
    await consumeOAuthRecord(db, 'RefreshToken', id, 1000);
    await consumeOAuthRecord(db, 'RefreshToken', id, 5000);
    expect((await findOAuthRecord(db, 'RefreshToken', id))?.consumedAt).toBe(1000);
    await upsertOAuthRecord(db, { kind: 'RefreshToken', id, payload: { n: 2 } });
    const row = await findOAuthRecord(db, 'RefreshToken', id);
    expect(row?.consumedAt).toBe(1000);
    expect(row?.payload.n).toBe(2);
  });

  it('claim spends an artifact exactly once, even when two callers race', async () => {
    const id = tag();
    await upsertOAuthRecord(db, { kind: 'RefreshToken', id, payload: {} });
    const results = await Promise.all([1, 2, 3].map(() => claimOAuthRecord(db, 'RefreshToken', id, 1000)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await claimOAuthRecord(db, 'RefreshToken', id, 2000)).toBe(false);
    expect((await findOAuthRecord(db, 'RefreshToken', id))?.consumedAt).toBe(1000);
    expect(await claimOAuthRecord(db, 'RefreshToken', tag())).toBe(false);
  });

  it('take is single-use and ignores expired rows', async () => {
    const id = tag();
    await upsertOAuthRecord(db, { kind: 'ConsentTicket', id, payload: { uid: 'u' }, expiresAt: Date.now() + 60_000 });
    const [a, b] = await Promise.all([takeOAuthRecord(db, 'ConsentTicket', id), takeOAuthRecord(db, 'ConsentTicket', id)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await takeOAuthRecord(db, 'ConsentTicket', id)).toBeUndefined();

    const stale = tag();
    await upsertOAuthRecord(db, { kind: 'ConsentTicket', id: stale, payload: {}, expiresAt: Date.now() - 1 });
    expect(await takeOAuthRecord(db, 'ConsentTicket', stale)).toBeUndefined();
  });

  it('revoking a grant deletes every artifact of it and nothing else', async () => {
    const grant = tag();
    const other = tag();
    for (const kind of ['Grant', 'GrantMeta']) await upsertOAuthRecord(db, { kind, id: grant, payload: {}, grantId: grant });
    await upsertOAuthRecord(db, { kind: 'RefreshToken', id: tag(), payload: {}, grantId: grant });
    await upsertOAuthRecord(db, { kind: 'AuthorizationCode', id: tag(), payload: {}, grantId: grant });
    const keep = tag();
    await upsertOAuthRecord(db, { kind: 'RefreshToken', id: keep, payload: {}, grantId: other });
    await revokeOAuthGrant(db, grant);
    const left = await db.all<{ id: string }>(sql`SELECT id FROM oauth_record WHERE grant_id IN (${grant}, ${other})`);
    expect(left.map((r) => r.id)).toEqual([keep]);
  });

  it('extends an expiry outward only, and leaves never-expiring rows alone', async () => {
    const id = tag();
    await upsertOAuthRecord(db, { kind: 'Client', id, payload: {}, expiresAt: Date.now() + 1000 });
    const far = Date.now() + 86_400_000;
    await extendOAuthRecordExpiry(db, 'Client', id, far);
    expect((await findOAuthRecord(db, 'Client', id))?.expiresAt).toBe(far);
    await extendOAuthRecordExpiry(db, 'Client', id, Date.now() + 5000);
    expect((await findOAuthRecord(db, 'Client', id))?.expiresAt).toBe(far);

    const forever = tag();
    await upsertOAuthRecord(db, { kind: 'Client', id: forever, payload: {} });
    await extendOAuthRecordExpiry(db, 'Client', forever, far);
    expect((await findOAuthRecord(db, 'Client', forever))?.expiresAt).toBeNull();
  });

  it('lists only one account\'s live rows, and a replace without an account keeps it', async () => {
    const a = tag();
    const b = tag();
    const mine = tag();
    await upsertOAuthRecord(db, { kind: 'GrantMeta', id: mine, payload: { n: 'mine' }, accountId: a, expiresAt: Date.now() + 60_000 });
    await upsertOAuthRecord(db, { kind: 'GrantMeta', id: tag(), payload: { n: 'theirs' }, accountId: b, expiresAt: Date.now() + 60_000 });
    await upsertOAuthRecord(db, { kind: 'GrantMeta', id: tag(), payload: { n: 'dead' }, accountId: a, expiresAt: Date.now() - 1 });
    await upsertOAuthRecord(db, { kind: 'GrantMeta', id: mine, payload: { n: 'mine2' }, expiresAt: Date.now() + 60_000 });
    const rows = await listOAuthRecordsForAccount(db, a, 'GrantMeta');
    expect(rows.map((r) => r.payload.n)).toEqual(['mine2']);
    expect(rows[0]!.accountId).toBe(a);
  });

  it('reports which ids are still live', async () => {
    const live = tag();
    const gone = tag();
    await upsertOAuthRecord(db, { kind: 'Grant', id: live, payload: {} });
    await upsertOAuthRecord(db, { kind: 'Grant', id: gone, payload: {}, expiresAt: Date.now() - 1 });
    expect([...(await liveOAuthRecordIds(db, 'Grant', [live, gone, tag()]))]).toEqual([live]);
    expect((await liveOAuthRecordIds(db, 'Grant', [])).size).toBe(0);
  });

  it('purges expired rows and long-spent refresh tokens, keeps recent ones', async () => {
    const expired = tag();
    const spentOld = tag();
    const spentNew = tag();
    const destroyed = tag();
    await upsertOAuthRecord(db, { kind: 'Interaction', id: expired, payload: {}, expiresAt: 10 });
    await upsertOAuthRecord(db, { kind: 'RefreshToken', id: spentOld, payload: {} });
    await consumeOAuthRecord(db, 'RefreshToken', spentOld, 100);
    await upsertOAuthRecord(db, { kind: 'RefreshToken', id: spentNew, payload: {} });
    await consumeOAuthRecord(db, 'RefreshToken', spentNew, Date.now());
    await upsertOAuthRecord(db, { kind: 'Session', id: destroyed, payload: {} });
    await destroyOAuthRecord(db, 'Session', destroyed);
    await purgeOAuthRecords(db, Date.now(), 1000);
    const ids = (await db.all<{ id: string }>(sql`SELECT id FROM oauth_record WHERE id IN (${expired}, ${spentOld}, ${spentNew}, ${destroyed})`)).map((r) => r.id);
    expect(ids).toEqual([spentNew]);
  });

  it('resolves the member behind a grant with its account', async () => {
    const alex = (await db.get<{ id: string; account_id: string }>(sql`SELECT id, account_id FROM member WHERE handle = 'alex-rivera'`))!;
    const subject = await getOAuthSubject(db, alex.id);
    expect(subject).toMatchObject({ memberId: alex.id, accountId: alex.account_id, accountCode: 'acme', status: 'active' });
    expect(await getOAuthSubject(db, randomUUID())).toBeUndefined();
  });
}

describe('oauth store (SQLite in-memory)', () => {
  oauthStoreContract(
    async () => {
      const db = await createDb('file::memory:');
      await migrate(db);
      await seed(db);
      return db;
    },
    (db) => db.close(),
  );
});

const url = process.env.DATABASE_URL ?? '';
const describePg = url.startsWith('postgres://') || url.startsWith('postgresql://') ? describe : describe.skip;

describePg('oauth store (real Postgres)', () => {
  oauthStoreContract(
    async () => {
      const db = await createDb(url);
      await migrate(db);
      // Seed ONLY if the demo account is missing: several spec files share one
      // Postgres and `seed()` re-inserts it wholesale (see vitest.config.ts).
      const existing = await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle = 'alex-rivera'`);
      if (!existing) await seed(db);
      return db;
    },
    (db) => db.close(),
  );
});
