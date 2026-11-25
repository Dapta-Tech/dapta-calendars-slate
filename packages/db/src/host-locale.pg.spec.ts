import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import { getPublicProfile } from './repository';
import { getTeamProfile } from './parity';

/**
 * The host and team language against a REAL Postgres. Its SQLite twin
 * (`host-locale.spec.ts`) owns the rules; this file exists for `teamLocale`'s
 * query, a join with a `CASE` in its `ORDER BY`, which is the one place the
 * dialects could part and SQLite would hide it.
 *
 * Every fixture here is created by this file and unique per run: a Postgres
 * `DATABASE_URL` is a persistent, SHARED database that other pg specs seed.
 */
const url = process.env.DATABASE_URL ?? '';
const isPg = url.startsWith('postgres://') || url.startsWith('postgresql://');
const describePg = isPg ? describe : describe.skip;

describePg('host language on the public profiles (real Postgres)', () => {
  let db: Db;
  let accountId: string;
  let accountCode: string;
  let ownerId: string;
  let otherId: string;
  let teamId: string;
  const teamSlug = 'locale-team';

  beforeAll(async () => {
    db = await createDb(url);
    await migrate(db);
    const now = Date.now();
    accountId = randomUUID();
    accountCode = 'lc' + accountId.slice(0, 6);
    await db.run(
      sql`INSERT INTO account (id, code, name, created_at) VALUES (${accountId}, ${accountCode}, ${'Locale Co'}, ${now})`,
    );
    ownerId = randomUUID();
    otherId = randomUUID();
    await db.run(
      sql`INSERT INTO member (id, account_id, handle, display_name, time_zone, role, locale, created_at)
          VALUES (${ownerId}, ${accountId}, ${'locale-owner'}, ${'Owner'}, ${'UTC'}, ${'owner'}, ${'en'}, ${now})`,
    );
    await db.run(
      sql`INSERT INTO member (id, account_id, handle, display_name, time_zone, role, locale, created_at)
          VALUES (${otherId}, ${accountId}, ${'locale-other'}, ${'Other'}, ${'UTC'}, ${'member'}, ${'es'}, ${now + 1})`,
    );
    teamId = randomUUID();
    await db.run(
      sql`INSERT INTO team (id, account_id, name, slug, logo_url, time_zone, hide_branding, created_at)
          VALUES (${teamId}, ${accountId}, ${'Locale team'}, ${teamSlug}, ${null}, ${'UTC'}, 0, ${now})`,
    );
    await db.run(
      sql`INSERT INTO team_membership (id, account_id, team_id, member_id, role, accepted, created_at)
          VALUES (${randomUUID()}, ${accountId}, ${teamId}, ${otherId}, ${'member'}, 1, ${now})`,
    );
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  it("carries the host's language on the person's profile", async () => {
    expect((await getPublicProfile(db, accountCode, 'locale-other'))!.member.locale).toBe('es');
  });

  it("gives a team its owner's language, else the workspace owner's", async () => {
    expect((await getTeamProfile(db, accountCode, teamSlug))!.team.locale).toBe('en');
    await db.run(sql`UPDATE team_membership SET role = 'owner' WHERE team_id = ${teamId} AND member_id = ${otherId}`);
    expect((await getTeamProfile(db, accountCode, teamSlug))!.team.locale).toBe('es');
  });
});
