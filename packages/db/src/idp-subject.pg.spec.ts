import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import { membershipsBySubject, recordMemberIdpSubject } from './idp-subject';

/**
 * `member.idp_subject` against a REAL Postgres. The SQLite twin
 * (`idp-subject.spec.ts`) owns the rules; this file exists for what only
 * Postgres does here: the `FOR UPDATE` transaction with `RETURNING`, and the
 * unique index deciding a race between two members of one account.
 *
 * Every fixture is created by this file and unique per run: a Postgres
 * `DATABASE_URL` is a persistent, shared database other pg specs seed.
 */
const url = process.env.DATABASE_URL ?? '';
const isPg = url.startsWith('postgres://') || url.startsWith('postgresql://');
const describePg = isPg ? describe : describe.skip;

describePg('member.idp_subject (real Postgres)', () => {
  let db: Db;
  const run = randomUUID().slice(0, 8);

  async function account(name: string): Promise<string> {
    const id = randomUUID();
    await db.run(sql`INSERT INTO account (id, code, name, created_at) VALUES (${id}, ${`i${id.slice(0, 7)}`}, ${name}, ${Date.now()})`);
    return id;
  }
  async function member(accountId: string): Promise<string> {
    const id = randomUUID();
    await db.run(
      sql`INSERT INTO member (id, account_id, handle, time_zone, role, status, created_at)
          VALUES (${id}, ${accountId}, ${`h${id.slice(0, 7)}`}, 'UTC', 'admin', 'active', ${Date.now()})`,
    );
    return id;
  }
  const subjectOf = async (id: string) => (await db.get<{ idp_subject: string | null }>(sql`SELECT idp_subject FROM member WHERE id = ${id}`))!.idp_subject;

  beforeAll(async () => {
    db = await createDb(url);
    await migrate(db);
  });
  afterAll(async () => {
    await db.close();
  });

  it('records, leaves an unchanged value alone, and takes the subject over within an account', async () => {
    const a = await account('Pg Acme');
    const first = await member(a);
    const second = await member(a);
    const subject = `user_pg_${run}`;
    expect(await recordMemberIdpSubject(db, a, first, subject)).toEqual({ written: true, clearedMemberIds: [] });
    expect(await recordMemberIdpSubject(db, a, first, subject)).toEqual({ written: false, clearedMemberIds: [] });
    expect(await recordMemberIdpSubject(db, a, second, subject)).toEqual({ written: true, clearedMemberIds: [first] });
    expect(await subjectOf(first)).toBeNull();
    expect(await subjectOf(second)).toBe(subject);
    const other = await account('Pg Globex');
    const there = await member(other);
    await recordMemberIdpSubject(db, other, there, subject);
    expect((await membershipsBySubject(db, subject)).map((m) => m.memberId).sort()).toEqual([second, there].sort());
  });

  it('two members of one account claiming one subject at once: one wins, and never both', async () => {
    const a = await account('Pg Race');
    const members = await Promise.all([member(a), member(a), member(a)]);
    const subject = `user_race_${run}`;
    const outcomes = await Promise.allSettled(members.map((m) => recordMemberIdpSubject(db, a, m, subject)));
    expect(outcomes.some((o) => o.status === 'fulfilled')).toBe(true);
    const holders = await db.all<{ id: string }>(sql`SELECT id FROM member WHERE account_id = ${a} AND idp_subject = ${subject}`);
    expect(holders).toHaveLength(1);
  });

  it('two parallel requests of the same login write once', async () => {
    const a = await account('Pg Twice');
    const m = await member(a);
    const subject = `user_twice_${run}`;
    const outcomes = await Promise.all([recordMemberIdpSubject(db, a, m, subject), recordMemberIdpSubject(db, a, m, subject)]);
    expect(outcomes.filter((o) => o.written)).toHaveLength(1);
  });
});
