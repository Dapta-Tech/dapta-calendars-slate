import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import { claimInvitationSend, inviteMember, releaseInvitationSend, takeInvitationQuota } from './members';
import { acceptInvitedMember, findMembership, listWorkspacesForIdentity } from './workspaces';

/**
 * The workspace reads against a REAL Postgres. The SQLite twin
 * (`workspaces.spec.ts`) owns the rules; this file exists for what only
 * Postgres does here: typing the parameters inside `CASE` and the joined
 * branches (by subject, by address only, with and without the account filter),
 * the per-account unique index the subject binding steers clear of, and two
 * acceptances of one invitation at once.
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
  // Strictly increasing: the list is oldest account first, and two accounts
  // made in the same millisecond would otherwise sort by their random ids.
  let clock = Date.now();

  async function account(name: string): Promise<string> {
    const id = randomUUID();
    await db.run(sql`INSERT INTO account (id, code, name, created_at) VALUES (${id}, ${`p${id.slice(0, 7)}`}, ${name}, ${clock++})`);
    return id;
  }
  async function member(accountId: string, email: string | null, externalId: string | null): Promise<string> {
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
    const home = await member(own, email, subject);
    const team = await account(`Pg team ${run}`);
    const inv = await inviteMember(db, team, { email });
    const id = inv.ok ? inv.value.id : '';

    const before = await listWorkspacesForIdentity(db, { externalId: subject, email }, home);
    expect(before.map((w) => [w.accountId, w.status])).toEqual([
      [own, 'active'],
      [team, 'invited'],
    ]);

    expect(await acceptInvitedMember(db, team, id, subject)).toBe(true);
    expect(await findMembership(db, { externalId: subject, email: null }, team)).toMatchObject({ memberId: id, status: 'active' });
  });

  it('by address alone: the list, the account filter, and acceptance with no subject', async () => {
    const email = `local-${run}@acme.test`;
    const own = await account(`Pg local ${run}`);
    const home = await member(own, email, null);
    const team = await account(`Pg local team ${run}`);
    const inv = await inviteMember(db, team, { email });
    const id = inv.ok ? inv.value.id : '';

    const identity = { externalId: null, email };
    expect((await listWorkspacesForIdentity(db, identity, home)).map((w) => w.accountId)).toEqual([own, team]);
    expect(await findMembership(db, identity, team)).toMatchObject({ memberId: id, status: 'invited' });
    expect(await findMembership(db, identity, own)).toBeNull(); // the home is the token's, not an invitation
    expect(await acceptInvitedMember(db, team, id, null)).toBe(true);
  });

  it('two instances claiming one member’s send at once: exactly one gets it', async () => {
    const team = await account(`Pg claim ${run}`);
    const inv = await inviteMember(db, team, { email: `claim-${run}@acme.test` });
    const id = inv.ok ? inv.value.id : '';
    const later = Date.now() + 120_000;
    const claims = await Promise.all(Array.from({ length: 8 }, () => claimInvitationSend(db, team, id, 60_000, later)));
    const won = claims.filter(Boolean);
    expect(won).toHaveLength(1);
    // Handed back (compare on the stored bigint, then reopen): the next claim passes at once.
    await releaseInvitationSend(db, team, id, won[0]!);
    expect(await claimInvitationSend(db, team, id, 60_000, later + 1)).not.toBeNull();
    // A stale release (that claim no longer holds the row) changes nothing.
    await releaseInvitationSend(db, team, id, won[0]!);
    expect(await claimInvitationSend(db, team, id, 60_000, later + 2)).toBeNull();
  });

  it('the daily allowance holds under concurrent sends', async () => {
    const team = await account(`Pg quota ${run}`);
    const results = await Promise.all(Array.from({ length: 12 }, () => takeInvitationQuota(db, team, 5)));
    expect(results.filter(Boolean)).toHaveLength(5);
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

  it('two acceptances at once: exactly one reports it', async () => {
    const email = `race-${run}@acme.test`;
    const team = await account(`Pg race ${run}`);
    const inv = await inviteMember(db, team, { email });
    const id = inv.ok ? inv.value.id : '';
    const results = await Promise.all([
      acceptInvitedMember(db, team, id, `sub_race_${run}`),
      acceptInvitedMember(db, team, id, `sub_race_${run}`),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
