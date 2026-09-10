import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import { getPublicProfile } from './repository';
import { createConnection, setConnectionAvatar } from './parity';

/**
 * The avatar fallback against a REAL Postgres. Its SQLite twin
 * (`connected-avatar.spec.ts`) owns the rules; this file exists for the one
 * place the dialects could diverge and SQLite would hide it.
 *
 * The ordering is the risk. `is_destination` is an `integer` in both dialects,
 * so `ORDER BY is_destination DESC` picks the destination in both — but if that
 * column ever becomes a real `boolean` on Postgres alone, `DESC` still sorts,
 * silently, in the other direction, and every host with two connected accounts
 * starts showing the wrong face on their public page. That is a production-only
 * break a SQLite suite passes.
 *
 * Every fixture here is created by this file and unique per run — a Postgres
 * `DATABASE_URL` is a persistent, SHARED database that other pg specs seed.
 * Nothing here reads or writes the demo `acme` account.
 */
const url = process.env.DATABASE_URL ?? '';
const isPg = url.startsWith('postgres://') || url.startsWith('postgresql://');
const describePg = isPg ? describe : describe.skip;

describePg('connected-account avatar (real Postgres)', () => {
  let db: Db;
  let accountId: string;
  let accountCode: string;
  let memberId: string;
  const handle = 'avatar-host';

  beforeAll(async () => {
    db = await createDb(url);
    await migrate(db);
    accountId = randomUUID();
    accountCode = 'av' + accountId.slice(0, 6);
    await db.run(
      sql`INSERT INTO account (id, code, name, created_at)
          VALUES (${accountId}, ${accountCode}, ${'Avatar Co'}, ${Date.now()})`,
    );
    memberId = randomUUID();
    await db.run(
      sql`INSERT INTO member (id, account_id, handle, display_name, time_zone, created_at)
          VALUES (${memberId}, ${accountId}, ${handle}, ${'Avatar Host'}, ${'UTC'}, ${Date.now()})`,
    );
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  const connect = (externalId: string, avatarUrl: string | null, isDestination = false) =>
    createConnection(db, {
      accountId,
      memberId,
      provider: 'google',
      externalId,
      avatarUrl,
      isDestination,
    });

  it('prefers the destination connection, and takes a photo that arrives later', async () => {
    await connect('pg-conn-A', 'https://cdn.example.test/other.jpg');
    await connect('pg-conn-B', null, true);

    // The destination has no photo yet, so the other connection answers.
    let profile = await getPublicProfile(db, accountCode, handle);
    expect(profile!.member.connectedAvatarUrl).toBe('https://cdn.example.test/other.jpg');

    // Once the destination reports one, it wins — the ordering is the point.
    await setConnectionAvatar(db, accountId, memberId, 'pg-conn-B', 'https://cdn.example.test/dest.jpg');
    profile = await getPublicProfile(db, accountCode, handle);
    expect(profile!.member.connectedAvatarUrl).toBe('https://cdn.example.test/dest.jpg');
  });

  it("does not look one up once the host has chosen their own", async () => {
    await db.run(
      sql`UPDATE member SET avatar_url = 'https://cdn.example.test/mine.png' WHERE id = ${memberId}`,
    );
    const profile = await getPublicProfile(db, accountCode, handle);
    expect(profile!.member.avatarUrl).toBe('https://cdn.example.test/mine.png');
    expect(profile!.member.connectedAvatarUrl).toBeNull();
  });
});
