import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import { inviteMember } from './members';
import { acceptInvitedMember, findMembership, listWorkspacesForIdentity } from './workspaces';

/**
 * The workspace reads against a REAL Postgres. The SQLite twin
 * (`workspaces.spec.ts`) owns the rules; this file exists for what only
 * Postgres does here: typing the parameters inside `CASE` and the joined
 * branches, and the per-account unique index the subject binding steers clear of.
 *
 * Every fixture is created by this file and unique per run: a Postgres
 * `DATABASE_URL` is a persistent, shared database other pg specs seed.
 */
const url = process.env.DATABASE_URL ?? '';
const isPg = url.startsWith('postgres://') || url.startsWith('postgresql://');
const describePg = isPg ? describe : describe.skip;

describePg('workspaces (real Postgres)', () => {
  let db: Db;
  const run = randomUUID().slice(0, 8);

  async function account(name: string): Promise<string> {
    const id = randomUUID();
    await db.run(sql`INSERT INTO account (id, code, name, created_at) VALUES (${id}, ${`p${id.slice(0, 7)}`}, ${name}, ${Date.now()})`);
    return id;
  }
  async function member(accountId: string, email: string, externalId: string | null): Promise<string> {
    const id = randomUUID();
    await db.run(
      sql`INSERT INTO member (id, account_id, external_id, email, handle, time_zone, role, status, created_at)
          VALUES (${id}, ${accountId}, ${externalId}, ${email}, ${`h${id.slice(0, 7)}`}, 'UTC', 'owner', 'active', ${Date.now()})`,
    );
    return id;
  }

  beforeAll(async () => {
    db = await createDb(url);
    await migrate(db);
  });
  afterAll(async () => {
    await db.close();
  });

  it('lists an invitation by address and accepts it, binding the subject', async () => {
    const email = `pablo-${run}@acme.test`;
    const subject = `sub_pablo_${run}`;
    const own = await account(`Pg own ${run}`);
    await member(own, email, subject);
    const team = await account(`Pg team ${run}`);
    const inv = await inviteMember(db, team, { email });
    const id = inv.ok ? inv.value.id : '';

    const before = await listWorkspacesForIdentity(db, { externalId: subject, email });
    expect(before.map((w) => [w.accountId, w.status])).toEqual([
      [own, 'active'],
      [team, 'invited'],
    ]);

    expect(await acceptInvitedMember(db, team, id, subject)).toBe(true);
    expect(await findMembership(db, { externalId: subject, email: null }, team)).toMatchObject({ memberId: id, status: 'active' });
  });

  it('activates without binding when the account already holds the subject', async () => {
    const email = `sam-${run}@acme.test`;
    const subject = `sub_sam_${run}`;
    const team = await account(`Pg both ${run}`);
    await member(team, email, subject);
    const inv = await inviteMember(db, team, { email: `other-${run}@acme.test` });
    const id = inv.ok ? inv.value.id : '';

    expect(await acceptInvitedMember(db, team, id, subject)).toBe(true);
    const row = await db.get<{ status: string; external_id: string | null }>(sql`SELECT status, external_id FROM member WHERE id = ${id}`);
    expect(row).toEqual({ status: 'active', external_id: null });
  });
});
