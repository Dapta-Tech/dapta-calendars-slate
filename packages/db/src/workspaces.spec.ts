import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import { inviteMember, refundInvitationQuota, takeInvitationQuota } from './members';
import { acceptInvitedMember, findMembership, getPersonIdentity, listWorkspacesForIdentity } from './workspaces';

/**
 * One person, several accounts, on SQLite: which accounts a person can act in
 * (their home, plus memberships an invitation granted), and accepting an
 * invitation. The Postgres twin (`workspaces.pg.spec.ts`) runs the same reads
 * where parameter typing differs.
 */

let db: Db;
let clock = 1_000;

async function account(name: string): Promise<string> {
  const id = randomUUID();
  await db.run(sql`INSERT INTO account (id, code, name, created_at) VALUES (${id}, ${`w${id.slice(0, 7)}`}, ${name}, ${clock++})`);
  return id;
}

async function member(
  accountId: string,
  opts: { email?: string | null; externalId?: string | null; status?: string; role?: string; invited?: boolean } = {},
): Promise<string> {
  const id = randomUUID();
  const at = clock++;
  await db.run(
    sql`INSERT INTO member (id, account_id, external_id, email, handle, time_zone, role, status, created_at, invited_at)
        VALUES (${id}, ${accountId}, ${opts.externalId ?? null}, ${opts.email ?? null}, ${`h${id.slice(0, 7)}`}, 'UTC',
          ${opts.role ?? 'owner'}, ${opts.status ?? 'active'}, ${at}, ${opts.invited ? at : null})`,
  );
  return id;
}

const row = (id: string) =>
  db.get<{ status: string; external_id: string | null }>(sql`SELECT status, external_id FROM member WHERE id = ${id}`);

beforeEach(async () => {
  db = await createDb('file::memory:');
  await migrate(db);
});

describe('listWorkspacesForIdentity', () => {
  it('lists the home account and an invitation to another, oldest account first', async () => {
    const own = await account('Pablo');
    const home = await member(own, { email: 'pablo@acme.test', externalId: 'sub_pablo' });
    const other = await account('Alejandro');
    await member(other, { email: 'alejandro@acme.test', externalId: 'sub_alejandro' });
    const invited = await inviteMember(db, other, { email: 'Pablo@Acme.test' });
    expect(invited.ok).toBe(true);

    const identity = await getPersonIdentity(db, own, home);
    expect(identity).toEqual({ externalId: 'sub_pablo', email: 'pablo@acme.test' });
    const list = await listWorkspacesForIdentity(db, identity!, home);
    expect(list.map((w) => [w.accountName, w.status, w.role])).toEqual([
      ['Pablo', 'active', 'owner'],
      ['Alejandro', 'invited', 'member'],
    ]);
  });

  it('leaves out a membership the person holds by subject but no invitation granted', async () => {
    const own = await account('Mine');
    const home = await member(own, { email: 'sam@acme.test', externalId: 'sub_sam' });
    // A row a sign-in through a token for that account created.
    const viaToken = await account('Upstream');
    await member(viaToken, { email: 'sam@acme.test', externalId: 'sub_sam', role: 'admin' });

    const identity = { externalId: 'sub_sam', email: 'sam@acme.test' };
    expect((await listWorkspacesForIdentity(db, identity, home)).map((w) => w.accountName)).toEqual(['Mine']);
    expect(await findMembership(db, identity, viaToken)).toBeNull();
  });

  it('never claims, by address, a row already bound to another subject', async () => {
    const own = await account('Mine');
    const home = await member(own, { email: 'sam@acme.test', externalId: 'sub_sam' });
    const foreign = await account('Theirs');
    await member(foreign, { email: 'sam@acme.test', externalId: 'sub_someone_else', invited: true });

    const list = await listWorkspacesForIdentity(db, { externalId: 'sub_sam', email: 'sam@acme.test' }, home);
    expect(list.map((w) => w.accountName)).toEqual(['Mine']);
  });

  it('leaves disabled memberships out', async () => {
    const own = await account('Mine');
    const home = await member(own, { email: 'sam@acme.test', externalId: 'sub_sam' });
    const gone = await account('Revoked');
    await member(gone, { email: 'sam@acme.test', status: 'disabled', invited: true });

    const identity = { externalId: 'sub_sam', email: 'sam@acme.test' };
    expect((await listWorkspacesForIdentity(db, identity, home)).map((w) => w.accountName)).toEqual(['Mine']);
    expect(await findMembership(db, identity, gone)).toBeNull();
  });

  it('keeps one row per account, the bound one first', async () => {
    const own = await account('Mine');
    const home = await member(own, { email: 'sam@acme.test', externalId: 'sub_sam' });
    const a = await account('Both');
    const bound = await member(a, { email: 'sam@acme.test', externalId: 'sub_sam', role: 'admin', invited: true });
    await member(a, { email: 'sam@acme.test', status: 'invited', role: 'member', invited: true });

    const identity = { externalId: 'sub_sam', email: 'sam@acme.test' };
    expect(await findMembership(db, identity, a)).toMatchObject({ memberId: bound, status: 'active', role: 'admin' });
    expect(await listWorkspacesForIdentity(db, identity, home)).toHaveLength(2);
  });

  it('works by address alone (the local provider has no subject)', async () => {
    const a = await account('Local');
    const home = await member(a, { email: 'jordan@example.com' });
    const b = await account('Other');
    await inviteMember(db, b, { email: 'jordan@example.com' });

    const list = await listWorkspacesForIdentity(db, { externalId: null, email: 'jordan@example.com' }, home);
    expect(list.map((w) => w.accountName)).toEqual(['Local', 'Other']);
  });

  it('prefers the address the session vouches for, and matches none when it vouches for none', async () => {
    const own = await account('Mine');
    const home = await member(own, { email: 'old@acme.test', externalId: 'sub_sam' });
    expect(await getPersonIdentity(db, own, home, { email: 'New@Acme.test' })).toEqual({ externalId: 'sub_sam', email: 'new@acme.test' });
    expect(await getPersonIdentity(db, own, home, { email: null })).toEqual({ externalId: 'sub_sam', email: null });
    expect(await getPersonIdentity(db, own, home)).toEqual({ externalId: 'sub_sam', email: 'old@acme.test' });
  });

  it('answers only the home account for an identity with neither key', async () => {
    const own = await account('Mine');
    const home = await member(own);
    expect((await listWorkspacesForIdentity(db, { externalId: null, email: null }, home)).map((w) => w.accountName)).toEqual(['Mine']);
  });
});

describe('inviteMember marks the membership as granted here', () => {
  it('stamps invited_at on the invited row only', async () => {
    const a = await account('Team');
    const inv = await inviteMember(db, a, { email: 'one@acme.test' });
    const owner = await member(a, { email: 'owner@acme.test' });
    const at = (id: string) => db.get<{ invited_at: number | string | null }>(sql`SELECT invited_at FROM member WHERE id = ${id}`);
    expect(Number((await at(inv.ok ? inv.value.id : ''))!.invited_at)).toBeGreaterThan(0);
    expect((await at(owner))!.invited_at).toBeNull();
  });
});

describe('the daily invitation allowance', () => {
  const NOON = Date.UTC(2026, 9, 20, 12);

  it('lets the cap through, refuses past it, per account and per UTC day', async () => {
    const a = await account('Team');
    const b = await account('Other');
    for (let i = 0; i < 3; i += 1) expect(await takeInvitationQuota(db, a, 3, NOON)).toBe(true);
    expect(await takeInvitationQuota(db, a, 3, NOON)).toBe(false);
    expect(await takeInvitationQuota(db, b, 3, NOON)).toBe(true);
    expect(await takeInvitationQuota(db, a, 3, NOON + 86_400_000)).toBe(true);
  });

  it('gives a send back only when one was taken', async () => {
    const a = await account('Team');
    expect(await takeInvitationQuota(db, a, 1, NOON)).toBe(true);
    await refundInvitationQuota(db, a, NOON);
    await refundInvitationQuota(db, a, NOON); // nothing left to give back: stays at zero
    expect(await takeInvitationQuota(db, a, 1, NOON)).toBe(true);
    expect(await takeInvitationQuota(db, a, 1, NOON)).toBe(false);
  });
});

describe('acceptInvitedMember', () => {
  it('activates the invitation once and binds it to the subject', async () => {
    const a = await account('Team');
    const inv = await inviteMember(db, a, { email: 'pablo@acme.test' });
    const id = inv.ok ? inv.value.id : '';

    expect(await acceptInvitedMember(db, a, id, 'sub_pablo')).toBe(true);
    expect(await row(id)).toEqual({ status: 'active', external_id: 'sub_pablo' });
    // The second request finds nothing left to accept.
    expect(await acceptInvitedMember(db, a, id, 'sub_pablo')).toBe(false);
    // From now on the row follows the subject, whatever the address.
    expect(await findMembership(db, { externalId: 'sub_pablo', email: 'new@acme.test' }, a)).toMatchObject({ memberId: id });
  });

  it('never revives a disabled member or rewrites an active one', async () => {
    const a = await account('Team');
    const disabled = await member(a, { email: 'x@acme.test', status: 'disabled', invited: true });
    const active = await member(a, { email: 'y@acme.test', externalId: 'sub_y', invited: true });

    expect(await acceptInvitedMember(db, a, disabled, 'sub_x')).toBe(false);
    expect(await row(disabled)).toEqual({ status: 'disabled', external_id: null });
    expect(await acceptInvitedMember(db, a, active, 'sub_other')).toBe(false);
    expect(await row(active)).toEqual({ status: 'active', external_id: 'sub_y' });
  });

  it('activates without binding when the subject is already taken in that account', async () => {
    const a = await account('Team');
    await member(a, { email: 'sam@acme.test', externalId: 'sub_sam' });
    const stray = await member(a, { email: 'sam@acme.test', status: 'invited', role: 'member', invited: true });

    expect(await acceptInvitedMember(db, a, stray, 'sub_sam')).toBe(true);
    expect(await row(stray)).toEqual({ status: 'active', external_id: null });
  });

  it('activates by address alone when there is no subject', async () => {
    const a = await account('Team');
    const inv = await inviteMember(db, a, { email: 'jordan@example.com' });
    const id = inv.ok ? inv.value.id : '';
    expect(await acceptInvitedMember(db, a, id, null)).toBe(true);
    expect(await row(id)).toEqual({ status: 'active', external_id: null });
  });
});
