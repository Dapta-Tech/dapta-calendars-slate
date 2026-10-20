import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import { membershipsBySubject, memberRoleAndLoginSeen, noteMemberLogin, recordMemberIdpSubject } from './idp-subject';

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

async function member(accountId: string, role = 'admin', status = 'active', externalId: string | null = null): Promise<string> {
  const id = randomUUID();
  await db.run(
    sql`INSERT INTO member (id, account_id, external_id, handle, time_zone, role, status, created_at)
        VALUES (${id}, ${accountId}, ${externalId}, ${`h${id.slice(0, 7)}`}, 'UTC', ${role}, ${status}, ${Date.now()})`,
  );
  return id;
}

const DAY = 86_400_000;
const seen = (id: string, at: number) => db.run(sql`UPDATE member SET login_seen_at = ${at} WHERE id = ${id}`);
const since = (now = Date.now()) => now - 30 * DAY;

const subjectOf = async (id: string) => (await db.get<{ idp_subject: string | null }>(sql`SELECT idp_subject FROM member WHERE id = ${id}`))!.idp_subject;

beforeEach(async () => {
  db = await createDb('file::memory:');
  await migrate(db);
});

describe('recordMemberIdpSubject', () => {
  it('records a subject once, stamping the login as seen, and reports nothing on the same value again', async () => {
    const a = await account('Acme');
    const m = await member(a);
    expect(await recordMemberIdpSubject(db, a, m, 'user_1', 1_000)).toEqual({ written: true, clearedMemberIds: [] });
    expect(await subjectOf(m)).toBe('user_1');
    expect((await memberRoleAndLoginSeen(db, a, m))!.loginSeenAt).toBe(1_000);
    expect(await recordMemberIdpSubject(db, a, m, 'user_1')).toEqual({ written: false, clearedMemberIds: [] });
  });

  it('never moves the stamp backwards, and stamps nothing without an issue time', async () => {
    const a = await account('Acme');
    const m = await member(a);
    await recordMemberIdpSubject(db, a, m, 'user_new_first', 5_000);
    await recordMemberIdpSubject(db, a, m, 'user_new_second', 1_000);
    expect(await subjectOf(m)).toBe('user_new_second');
    expect((await memberRoleAndLoginSeen(db, a, m))!.loginSeenAt).toBe(5_000);
    const n = await member(a);
    await recordMemberIdpSubject(db, a, n, 'user_no_time', null);
    expect(await subjectOf(n)).toBe('user_no_time');
    expect((await memberRoleAndLoginSeen(db, a, n))!.loginSeenAt).toBeNull();
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

describe('noteMemberLogin', () => {
  it('stamps a member never seen, then writes again only once the stamp is a day old', async () => {
    const a = await account('Acme');
    const m = await member(a);
    const t0 = 10 * DAY;
    expect(await noteMemberLogin(db, a, m, t0, DAY)).toBe(true);
    expect(await noteMemberLogin(db, a, m, t0 + DAY - 1, DAY)).toBe(false);
    expect((await memberRoleAndLoginSeen(db, a, m))!.loginSeenAt).toBe(t0);
    expect(await noteMemberLogin(db, a, m, t0 + DAY + 1, DAY)).toBe(true);
    expect((await memberRoleAndLoginSeen(db, a, m))!.loginSeenAt).toBe(t0 + DAY + 1);
    // Another account's member, or one that does not exist, is never touched.
    const b = await account('Globex');
    expect(await noteMemberLogin(db, b, m, t0 + 5 * DAY, DAY)).toBe(false);
    expect(await memberRoleAndLoginSeen(db, b, m)).toBeNull();
  });
});

describe('membershipsBySubject', () => {
  it('returns every member carrying the subject with its role, status and account name, oldest account first', async () => {
    const newer = await account('Newer', Date.now());
    const older = await account('Older', Date.now() - DAY);
    const mNewer = await member(newer, 'member', 'active');
    const mOlder = await member(older, 'owner', 'disabled');
    await recordMemberIdpSubject(db, newer, mNewer, 'user_m');
    await recordMemberIdpSubject(db, older, mOlder, 'user_m');
    expect(await membershipsBySubject(db, 'user_m', since())).toEqual([
      { memberId: mOlder, accountId: older, accountName: 'Older', role: 'owner', status: 'disabled' },
      { memberId: mNewer, accountId: newer, accountName: 'Newer', role: 'member', status: 'active' },
    ]);
    expect(await membershipsBySubject(db, 'user_none', since())).toEqual([]);
  });

  it('honors a fresh link and refuses a stale one', async () => {
    const a = await account('Acme');
    const m = await member(a);
    await recordMemberIdpSubject(db, a, m, 'user_age');
    expect(await membershipsBySubject(db, 'user_age', since())).toHaveLength(1);
    await seen(m, Date.now() - 31 * DAY);
    expect(await membershipsBySubject(db, 'user_age', since())).toEqual([]);
    await db.run(sql`UPDATE member SET login_seen_at = NULL WHERE id = ${m}`);
    expect(await membershipsBySubject(db, 'user_age', since())).toEqual([]);
  });

  it("reaches the person's members in other accounts through the upstream user id, each only while it is itself fresh", async () => {
    const primary = await account('Primary', Date.now() - 2 * DAY);
    const switched = await account('Switched', Date.now() - DAY);
    const stranger = await account('Stranger');
    const linked = await member(primary, 'admin', 'active', 'iam_user_1');
    // The session for the switched-to account carried no subject: never linked there.
    const other = await member(switched, 'owner', 'active', 'iam_user_1');
    const someoneElse = await member(stranger, 'owner', 'active', 'iam_user_2');
    await recordMemberIdpSubject(db, primary, linked, 'user_person');
    await seen(other, Date.now());
    await seen(someoneElse, Date.now());
    expect((await membershipsBySubject(db, 'user_person', since())).map((r) => r.memberId)).toEqual([linked, other]);
    // Not seen in the switched-to account for longer than the window: that account drops out.
    await seen(other, Date.now() - 40 * DAY);
    expect((await membershipsBySubject(db, 'user_person', since())).map((r) => r.memberId)).toEqual([linked]);
    // The link itself gone stale: nothing, even where the person was seen.
    await seen(other, Date.now());
    await seen(linked, Date.now() - 40 * DAY);
    expect(await membershipsBySubject(db, 'user_person', since())).toEqual([]);
  });

  it('takes both upstream users when two of them carry the same subject', async () => {
    const a = await account('A', Date.now() - 3 * DAY);
    const b = await account('B', Date.now() - 2 * DAY);
    const c = await account('C', Date.now() - DAY);
    const ua = await member(a, 'admin', 'active', 'iam_a');
    const ub = await member(b, 'admin', 'active', 'iam_b');
    const ubElsewhere = await member(c, 'admin', 'active', 'iam_b');
    await recordMemberIdpSubject(db, a, ua, 'user_twice');
    await recordMemberIdpSubject(db, b, ub, 'user_twice');
    await seen(ubElsewhere, Date.now());
    expect((await membershipsBySubject(db, 'user_twice', since())).map((r) => r.memberId)).toEqual([ua, ub, ubElsewhere]);
  });
});
