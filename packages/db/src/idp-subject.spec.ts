import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import { membershipsBySubject, recordMemberIdpSubject } from './idp-subject';

/**
 * `member.idp_subject` on SQLite: recording a sign-in subject at web login
 * (the latest login within an account takes it) and finding a subject's
 * members for the MCP door. The Postgres twin (`idp-subject.pg.spec.ts`)
 * covers the row lock and the unique index under a race.
 */

let db: Db;

async function account(name: string, createdAt = Date.now()): Promise<string> {
  const id = randomUUID();
  await db.run(sql`INSERT INTO account (id, code, name, created_at) VALUES (${id}, ${`c${id.slice(0, 7)}`}, ${name}, ${createdAt})`);
  return id;
}

async function member(accountId: string, role = 'admin', status = 'active'): Promise<string> {
  const id = randomUUID();
  await db.run(
    sql`INSERT INTO member (id, account_id, handle, time_zone, role, status, created_at)
        VALUES (${id}, ${accountId}, ${`h${id.slice(0, 7)}`}, 'UTC', ${role}, ${status}, ${Date.now()})`,
  );
  return id;
}

const subjectOf = async (id: string) => (await db.get<{ idp_subject: string | null }>(sql`SELECT idp_subject FROM member WHERE id = ${id}`))!.idp_subject;

beforeEach(async () => {
  db = await createDb('file::memory:');
  await migrate(db);
});

describe('recordMemberIdpSubject', () => {
  it('records a subject once, and reports nothing on the same value again', async () => {
    const a = await account('Acme');
    const m = await member(a);
    expect(await recordMemberIdpSubject(db, a, m, 'user_1')).toEqual({ written: true, clearedMemberIds: [] });
    expect(await subjectOf(m)).toBe('user_1');
    expect(await recordMemberIdpSubject(db, a, m, 'user_1')).toEqual({ written: false, clearedMemberIds: [] });
  });

  it('rewrites a changed subject', async () => {
    const a = await account('Acme');
    const m = await member(a);
    await recordMemberIdpSubject(db, a, m, 'user_old');
    expect((await recordMemberIdpSubject(db, a, m, 'user_new')).written).toBe(true);
    expect(await subjectOf(m)).toBe('user_new');
  });

  it('within one account the latest login takes the subject from the member who held it', async () => {
    const a = await account('Acme');
    const first = await member(a);
    const second = await member(a);
    await recordMemberIdpSubject(db, a, first, 'user_shared');
    expect(await recordMemberIdpSubject(db, a, second, 'user_shared')).toEqual({ written: true, clearedMemberIds: [first] });
    expect(await subjectOf(first)).toBeNull();
    expect(await subjectOf(second)).toBe('user_shared');
  });

  it('one subject may hold a member in each of several accounts', async () => {
    const a = await account('Acme');
    const b = await account('Globex');
    const ma = await member(a);
    const mb = await member(b);
    await recordMemberIdpSubject(db, a, ma, 'user_multi');
    expect(await recordMemberIdpSubject(db, b, mb, 'user_multi')).toEqual({ written: true, clearedMemberIds: [] });
    expect(await subjectOf(ma)).toBe('user_multi');
  });

  it('writes nothing for a member of another account or one that does not exist', async () => {
    const a = await account('Acme');
    const b = await account('Globex');
    const m = await member(a);
    expect((await recordMemberIdpSubject(db, b, m, 'user_x')).written).toBe(false);
    expect((await recordMemberIdpSubject(db, a, randomUUID(), 'user_x')).written).toBe(false);
    expect(await subjectOf(m)).toBeNull();
  });

  it('the unique index refuses two members of one account with the same subject', async () => {
    const a = await account('Acme');
    const first = await member(a);
    const second = await member(a);
    await db.run(sql`UPDATE member SET idp_subject = 'user_dup' WHERE id = ${first}`);
    const refused = await (async () => db.run(sql`UPDATE member SET idp_subject = 'user_dup' WHERE id = ${second}`))().catch((e: unknown) => e);
    expect((refused as { cause?: { code?: string } }).cause?.code).toBe('SQLITE_CONSTRAINT_UNIQUE');
  });
});

describe('membershipsBySubject', () => {
  it('returns every member carrying the subject with its role, status and account name, oldest account first', async () => {
    const newer = await account('Newer', Date.now());
    const older = await account('Older', Date.now() - 86_400_000);
    const mNewer = await member(newer, 'member', 'active');
    const mOlder = await member(older, 'owner', 'disabled');
    await recordMemberIdpSubject(db, newer, mNewer, 'user_m');
    await recordMemberIdpSubject(db, older, mOlder, 'user_m');
    expect(await membershipsBySubject(db, 'user_m')).toEqual([
      { memberId: mOlder, accountId: older, accountName: 'Older', role: 'owner', status: 'disabled' },
      { memberId: mNewer, accountId: newer, accountName: 'Newer', role: 'member', status: 'active' },
    ]);
    expect(await membershipsBySubject(db, 'user_none')).toEqual([]);
  });
});
