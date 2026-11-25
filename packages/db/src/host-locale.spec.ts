import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import { seed } from './seed';
import { getAccountByCode, getPublicProfile } from './repository';
import { getTeamProfile } from './parity';

/**
 * The host's language on the public payloads. A link preview falls back to it
 * when the robot drawing the preview states no language (Slack states none), so
 * a Spanish host's link previews in Spanish. A team has no language of its own:
 * it speaks its owner's, else the workspace owner's.
 */
describe('host language on the public profiles (SQLite in-memory)', () => {
  let db: Db;
  let accountId: string;

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    accountId = (await getAccountByCode(db, 'acme'))!.id;
  });

  const setLocale = (handle: string, locale: string | null) =>
    db.run(sql`UPDATE member SET locale = ${locale} WHERE account_id = ${accountId} AND handle = ${handle}`);

  it("carries the host's language, null while they have none", async () => {
    expect((await getPublicProfile(db, 'acme', 'alex-rivera'))!.member.locale).toBeNull();
    await setLocale('alex-rivera', 'es');
    expect((await getPublicProfile(db, 'acme', 'alex-rivera'))!.member.locale).toBe('es');
  });

  it('reads a regional tag as its language and anything unknown as none', async () => {
    await setLocale('alex-rivera', 'es-CO');
    expect((await getPublicProfile(db, 'acme', 'alex-rivera'))!.member.locale).toBe('es');
    await setLocale('alex-rivera', 'fr');
    expect((await getPublicProfile(db, 'acme', 'alex-rivera'))!.member.locale).toBeNull();
  });

  it("gives a team its owner's language, else the workspace owner's, else none", async () => {
    expect((await getTeamProfile(db, 'acme', 'sales'))!.team.locale).toBeNull();

    // Nobody owns the seeded team yet: the workspace owner (alex) answers.
    await setLocale('alex-rivera', 'en');
    await setLocale('jordan-lee', 'es');
    expect((await getTeamProfile(db, 'acme', 'sales'))!.team.locale).toBe('en');

    // A team owner with a language outranks the workspace owner.
    await db.run(
      sql`UPDATE team_membership SET role = 'owner'
          WHERE member_id = (SELECT id FROM member WHERE account_id = ${accountId} AND handle = 'jordan-lee')`,
    );
    expect((await getTeamProfile(db, 'acme', 'sales'))!.team.locale).toBe('es');

    // A disabled owner no longer speaks for the team.
    await db.run(sql`UPDATE member SET status = 'disabled' WHERE account_id = ${accountId} AND handle = 'jordan-lee'`);
    expect((await getTeamProfile(db, 'acme', 'sales'))!.team.locale).toBe('en');
    await db.run(sql`UPDATE member SET status = 'active' WHERE account_id = ${accountId} AND handle = 'jordan-lee'`);

    // A team owner with no language falls through to the workspace owner.
    await setLocale('jordan-lee', null);
    expect((await getTeamProfile(db, 'acme', 'sales'))!.team.locale).toBe('en');
  });
});
