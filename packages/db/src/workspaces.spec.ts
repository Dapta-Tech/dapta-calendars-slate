import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import { inviteMember } from './members';
import { acceptInvitedMember, findMembership, getPersonIdentity, listWorkspacesForIdentity } from './workspaces';

/**
 * One person, several accounts, on SQLite: which accounts a person can act in,
 * and accepting an invitation by acting in it. The Postgres twin
 * (`workspaces.pg.spec.ts`) runs the same reads where parameter typing differs.
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
  opts: { email?: string | null; externalId?: string | null; status?: string; role?: string } = {},
): Promise<string> {
  const id = randomUUID();
  await db.run(
    sql`INSERT INTO member (id, account_id, external_id, email, handle, time_zone, role, status, created_at)
        VALUES (${id}, ${accountId}, ${opts.externalId ?? null}, ${opts.email ?? null}, ${`h${id.slice(0, 7)}`}, 'UTC',
          ${opts.role ?? 'owner'}, ${opts.status ?? 'active'}, ${clock++})`,
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
  it('lists the own account and an invitation to another, oldest account first', async () => {
    const own = await account('Pablo');
    const home = await member(own, { email: 'pablo@acme.test', externalId: 'sub_pablo' });
    const other = await account('Alejandro');
    await member(other, { email: 'alejandro@acme.test', externalId: 'sub_alejandro' });
    const invited = await inviteMember(db, other, { email: 'Pablo@Acme.test' });
    expect(invited.ok).toBe(true);

    const identity = await getPersonIdentity(db, own, home);
    expect(identity).toEqual({ externalId: 'sub_pablo', email: 'pablo@acme.test' });
    const list = await listWorkspacesForIdentity(db, identity!);
    expect(list.map((w) => [w.accountName, w.status, w.role])).toEqual([
      ['Pablo', 'active', 'owner'],
      ['Alejandro', 'invited', 'member'],
    ]);
  });

  it('never claims, by address, a row already bound to another subject', async () => {
    const own = await account('Mine');
    await member(own, { email: 'sam@acme.test', externalId: 'sub_sam' });
    const foreign = await account('Theirs');
    await member(foreign, { email: 'sam@acme.test', externalId: 'sub_someone_else' });

    const list = await listWorkspacesForIdentity(db, { externalId: 'sub_sam', email: 'sam@acme.test' });
    expect(list.map((w) => w.accountName)).toEqual(['Mine']);
  });

  it('leaves disabled memberships out', async () => {
    const own = await account('Mine');
    await member(own, { email: 'sam@acme.test', externalId: 'sub_sam' });
    const gone = await account('Revoked');
    await member(gone, { email: 'sam@acme.test', status: 'disabled' });

    const list = await listWorkspacesForIdentity(db, { externalId: 'sub_sam', email: 'sam@acme.test' });
    expect(list.map((w) => w.accountName)).toEqual(['Mine']);
    expect(await findMembership(db, { externalId: 'sub_sam', email: 'sam@acme.test' }, gone)).toBeNull();
  });

  it('keeps one row per account, the bound one first', async () => {
    const a = await account('Both');
    const bound = await member(a, { email: 'sam@acme.test', externalId: 'sub_sam', role: 'admin' });
    await member(a, { email: 'sam@acme.test', status: 'invited', role: 'member' });

    const found = await findMembership(db, { externalId: 'sub_sam', email: 'sam@acme.test' }, a);
    expect(found).toMatchObject({ memberId: bound, status: 'active', role: 'admin' });
    expect(await listWorkspacesForIdentity(db, { externalId: 'sub_sam', email: 'sam@acme.test' })).toHaveLength(1);
  });

  it('works by address alone (the local provider has no subject)', async () => {
    const a = await account('Local');
    await member(a, { email: 'jordan@example.com' });
    const b = await account('Other');
    await inviteMember(db, b, { email: 'jordan@example.com' });

    const list = await listWorkspacesForIdentity(db, { externalId: null, email: 'jordan@example.com' });
    expect(list.map((w) => w.accountName)).toEqual(['Local', 'Other']);
  });

  it('answers nothing for an identity with neither key', async () => {
    expect(await listWorkspacesForIdentity(db, { externalId: null, email: null })).toEqual([]);
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
    const list = await listWorkspacesForIdentity(db, { externalId: 'sub_pablo', email: 'new@acme.test' });
    expect(list.map((w) => w.memberId)).toEqual([id]);
  });

  it('never revives a disabled member or rewrites an active one', async () => {
    const a = await account('Team');
    const disabled = await member(a, { email: 'x@acme.test', status: 'disabled' });
    const active = await member(a, { email: 'y@acme.test', externalId: 'sub_y' });

    expect(await acceptInvitedMember(db, a, disabled, 'sub_x')).toBe(false);
    expect(await row(disabled)).toEqual({ status: 'disabled', external_id: null });
    expect(await acceptInvitedMember(db, a, active, 'sub_other')).toBe(false);
    expect(await row(active)).toEqual({ status: 'active', external_id: 'sub_y' });
  });

  it('activates without binding when the subject is already taken in that account', async () => {
    const a = await account('Team');
    await member(a, { email: 'sam@acme.test', externalId: 'sub_sam' });
    const stray = await member(a, { email: 'sam@acme.test', status: 'invited', role: 'member' });

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
