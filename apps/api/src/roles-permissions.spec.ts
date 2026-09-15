/**
 * The permission matrix: each account role × each guarded route → allow / 403,
 * plus the last-owner guard and admin-cannot-touch-owner rule. Exercises the real
 * controllers against an in-memory DB with a controllable principal (a fake
 * AuthService), so the guards are tested where they actually run.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ForbiddenException, ConflictException, NotFoundException } from '@nestjs/common';
import {
  sql,
  createDb,
  migrate,
  seed,
  changeMemberRole,
  createEventType,
  type Db,
  type AccountRole,
} from '@slate/db';
import { AdminCrudController } from './admin-crud.controller';
import { HostController } from './host.controller';
import type { AuthService, HostPrincipal, ReqLike } from './auth.service';
import {
  isAdmin,
  isOwner,
  assertAdmin,
  assertOwner,
  assertOwnsOrAdmin,
  assertCanManageTarget,
} from './permissions';

const REQ: ReqLike = { headers: {} };

/** A fake AuthService whose resolved principal we flip per-call. */
class FakeAuth {
  current: HostPrincipal = { accountId: '', memberId: '', role: 'member' };
  resolveHost(): Promise<HostPrincipal> {
    return Promise.resolve(this.current);
  }
}

describe('permission layer — pure capability helpers', () => {
  it('isAdmin / isOwner classify the role tiers', () => {
    expect(isOwner('owner')).toBe(true);
    expect(isOwner('admin')).toBe(false);
    expect(isAdmin('owner')).toBe(true);
    expect(isAdmin('admin')).toBe(true);
    expect(isAdmin('member')).toBe(false);
  });

  it('assertAdmin / assertOwner throw 403 below the tier', () => {
    const member = { memberId: 'm', role: 'member' as AccountRole };
    const admin = { memberId: 'a', role: 'admin' as AccountRole };
    expect(() => assertAdmin(member)).toThrow(ForbiddenException);
    expect(() => assertAdmin(admin)).not.toThrow();
    expect(() => assertOwner(admin)).toThrow(ForbiddenException);
    expect(() => assertOwner({ memberId: 'o', role: 'owner' })).not.toThrow();
  });

  it('assertOwnsOrAdmin: member only their own; admin anyone; null owner is admin-only', () => {
    const member = { memberId: 'm1', role: 'member' as AccountRole };
    expect(() => assertOwnsOrAdmin(member, 'm1')).not.toThrow();
    expect(() => assertOwnsOrAdmin(member, 'm2')).toThrow(ForbiddenException);
    expect(() => assertOwnsOrAdmin(member, null)).toThrow(ForbiddenException);
    const admin = { memberId: 'a', role: 'admin' as AccountRole };
    expect(() => assertOwnsOrAdmin(admin, 'm2')).not.toThrow();
    expect(() => assertOwnsOrAdmin(admin, null)).not.toThrow();
  });

  it('assertCanManageTarget: only an owner may touch an owner or grant ownership', () => {
    const admin = { memberId: 'a', role: 'admin' as AccountRole };
    const owner = { memberId: 'o', role: 'owner' as AccountRole };
    expect(() => assertCanManageTarget(admin, { role: 'member' })).not.toThrow();
    expect(() => assertCanManageTarget(admin, { role: 'owner' })).toThrow(ForbiddenException);
    expect(() => assertCanManageTarget(admin, { role: 'member' }, { toRole: 'owner' })).toThrow(
      ForbiddenException,
    );
    expect(() => assertCanManageTarget(owner, { role: 'owner' }, { toRole: 'owner' })).not.toThrow();
  });
});

describe('permission matrix — guarded routes (real controllers)', () => {
  let db: Db;
  let auth: FakeAuth;
  let crud: AdminCrudController;
  let host: HostController;
  let accountId: string;
  let alex: string; // owner
  let jordan: string; // member

  const as = (role: AccountRole, memberId: string) => {
    auth.current = { accountId, memberId, role };
  };

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code='acme'`))!.id;
    alex = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='alex-rivera'`))!.id;
    jordan = (await db.get<{ id: string }>(sql`SELECT id FROM member WHERE handle='jordan-lee'`))!.id;
    auth = new FakeAuth();
    // AdminService is only reached AFTER the guard for the host routes we test,
    // so a minimal stub is enough to prove the 403s.
    const adminStub = {
      listApiKeys: () => Promise.resolve([]),
      listWebhooks: () => Promise.resolve([]),
    };
    crud = new AdminCrudController(db, auth as unknown as AuthService);
    // Onboarding is likewise past the guard on every route asserted here.
    host = new HostController(adminStub as never, {} as never, auth as unknown as AuthService, {} as never);
  });

  // --- Member management (admin/owner only; admins can't touch owners) ------

  it('GET /members: member 403, admin/owner allowed', async () => {
    as('member', jordan);
    await expect(crud.members(REQ)).rejects.toBeInstanceOf(ForbiddenException);
    as('owner', alex);
    const list = await crud.members(REQ);
    expect(list.find((m) => m.id === alex)).toMatchObject({ role: 'owner' });
  });

  it('POST /members (invite): member 403; admin invites; duplicate 409', async () => {
    as('member', jordan);
    await expect(
      crud.inviteMember(REQ, { email: 'x@example.com' }),
    ).rejects.toBeInstanceOf(ForbiddenException);

    await changeMemberRole(db, accountId, jordan, 'admin'); // promote for the admin cases
    as('admin', jordan);
    const invited = await crud.inviteMember(REQ, { email: 'new@example.com', role: 'member' });
    expect(invited).toMatchObject({ email: 'new@example.com', status: 'invited' });
    await expect(
      crud.inviteMember(REQ, { email: 'new@example.com' }),
    ).rejects.toBeInstanceOf(ConflictException); // EMAIL_TAKEN
  });

  it('PATCH /members/:id: admin cannot touch an owner or grant ownership', async () => {
    await changeMemberRole(db, accountId, jordan, 'admin');
    as('admin', jordan);
    // Admin acting on the owner (alex) → 403.
    await expect(
      crud.updateMember(REQ, alex, { role: 'member' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    // Admin promoting anyone to owner → 403.
    const staff = (await crud.inviteMember(REQ, { email: 's@example.com' })) as { id: string };
    await expect(
      crud.updateMember(REQ, staff.id, { role: 'owner' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    // Admin changing a normal member's status → OK.
    const off = await crud.updateMember(REQ, staff.id, { status: 'disabled' });
    expect(off).toMatchObject({ status: 'disabled' });
  });

  it('no self-administration: a caller cannot change or remove their own membership', async () => {
    // Even the owner cannot demote/remove themselves via the members endpoints
    // (own-profile edits go through /v1/me; this prevents self-lockout/escalation).
    as('owner', alex);
    await expect(
      crud.updateMember(REQ, alex, { role: 'member' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      crud.updateMember(REQ, alex, { status: 'disabled' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(crud.removeMember(REQ, alex)).rejects.toBeInstanceOf(ForbiddenException);
    // Acting on ANOTHER member is unaffected.
    await changeMemberRole(db, accountId, jordan, 'admin');
    as('owner', alex);
    const other = await crud.updateMember(REQ, jordan, { role: 'member' });
    expect(other).toMatchObject({ role: 'member' });
  });

  it('DELETE /members/:id: member 403; owner removes another member', async () => {
    as('member', jordan);
    await expect(crud.removeMember(REQ, alex)).rejects.toBeInstanceOf(ForbiddenException);
    as('owner', alex);
    expect(await crud.removeMember(REQ, jordan)).toEqual({ ok: true });
  });

  // --- Own-resource scoping (event-types) -----------------------------------

  it('event-types: a member edits only their own; admin/owner edit anyone’s', async () => {
    // Alex (owner) owns an event-type; Jordan (member) owns one too.
    const alexEt = (await createEventType(db, accountId, alex, {
      slug: 'owner-call',
      title: 'Owner Call',
      lengthMinutes: 30,
    }));
    const jordanEt = await createEventType(db, accountId, jordan, {
      slug: 'staff-call',
      title: 'Staff Call',
      lengthMinutes: 30,
    });
    if (!alexEt.ok || !jordanEt.ok) throw new Error('setup');

    // Member editing someone else's event-type → 403; own → OK.
    as('member', jordan);
    await expect(
      crud.updateEventType(REQ, alexEt.value.id, { title: 'Hijack' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const own = await crud.updateEventType(REQ, jordanEt.value.id, { title: 'My Call' });
    expect(own.title).toBe('My Call');

    // Admin (owner tier) may edit the member's event-type.
    as('owner', alex);
    const edited = await crud.updateEventType(REQ, jordanEt.value.id, { title: 'Reassigned' });
    expect(edited.title).toBe('Reassigned');
  });

  it('creating a TEAM event-type requires admin/owner', async () => {
    const team = (await db.get<{ id: string }>(sql`SELECT id FROM team WHERE slug='sales'`))!.id;
    as('member', jordan);
    await expect(
      crud.createEventType(REQ, { slug: 't1', title: 'T', lengthMinutes: 30, teamId: team }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    as('owner', alex);
    const ok = await crud.createEventType(REQ, {
      slug: 't2',
      title: 'T2',
      lengthMinutes: 30,
      teamId: team,
    });
    expect(ok.teamId).toBe(team);
  });

  // --- Teams + Developer surfaces -------------------------------------------

  it('team create is admin-only; member 403', async () => {
    as('member', jordan);
    await expect(
      crud.createTeam(REQ, { name: 'Crew', slug: 'crew' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    as('owner', alex);
    expect(await crud.createTeam(REQ, { name: 'Crew', slug: 'crew' })).toMatchObject({ slug: 'crew' });
  });

  it('Developer surface (api-keys, webhooks) is admin-only', async () => {
    as('member', jordan);
    await expect(host.listApiKeys(REQ)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(host.listWebhooks(REQ)).rejects.toBeInstanceOf(ForbiddenException);
    as('owner', alex);
    expect(await host.listApiKeys(REQ)).toEqual([]);
    expect(await host.listWebhooks(REQ)).toEqual([]);
  });
  // --- One-off invite links (#69 / AB2, #110) -------------------------------
  //
  // The three routes are guarded ONLY by the permission check on the event type
  // they name, so each one is asserted here where that guard actually runs. An
  // earlier revision passed the permission check and then mutated a link
  // addressed by id alone, which made the check vacuous with respect to the row
  // it wrote; the last test in this block is the one that catches that.

  it('one-off links: a member mints, lists and revokes only on their OWN event', async () => {
    const alexEt = (await createEventType(db, accountId, alex, {
      slug: 'alex-private',
      title: 'Alex Private',
      lengthMinutes: 30,
      scheduleId: null,
      hidden: true,
    })) as { ok: true; value: { id: string } };
    const jordanEt = (await createEventType(db, accountId, jordan, {
      slug: 'jordan-private',
      title: 'Jordan Private',
      lengthMinutes: 30,
      scheduleId: null,
      hidden: true,
    })) as { ok: true; value: { id: string } };

    as('member', jordan);
    await expect(
      crud.createEventTypeOneOffLink(REQ, alexEt.value.id),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      crud.listEventTypeOneOffLinks(REQ, alexEt.value.id),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      crud.revokeEventTypeOneOffLink(REQ, alexEt.value.id, 'whatever'),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const own = await crud.createEventTypeOneOffLink(REQ, jordanEt.value.id);
    expect(own).toMatchObject({ state: 'live' });
    expect(own.path).toBe(`/booking/${own.token}`);
    expect(await crud.listEventTypeOneOffLinks(REQ, jordanEt.value.id)).toHaveLength(1);

    // An owner reaches anyone's.
    as('owner', alex);
    expect(await crud.listEventTypeOneOffLinks(REQ, jordanEt.value.id)).toHaveLength(1);
  });

  it('one-off links on a TEAM event are admin-only, like every other team resource', async () => {
    as('owner', alex);
    const team = (await crud.createTeam(REQ, { name: 'Sales', slug: 'sales-oneoff' })).id;
    const teamEt = await crud.createEventType(REQ, {
      slug: 'team-private',
      title: 'Team Private',
      lengthMinutes: 30,
      teamId: team,
    });

    // A team event type has no `memberId`, which `assertOwnsOrAdmin` treats as
    // admin-and-owner territory.
    as('member', jordan);
    await expect(
      crud.createEventTypeOneOffLink(REQ, teamEt.id),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      crud.revokeEventTypeOneOffLink(REQ, teamEt.id, 'whatever'),
    ).rejects.toBeInstanceOf(ForbiddenException);

    as('owner', alex);
    expect(await crud.createEventTypeOneOffLink(REQ, teamEt.id)).toMatchObject({ state: 'live' });
  });

  it('one-off links: another account’s event type answers 404, never 403', async () => {
    // No oracle: a principal must not be able to learn which event-type ids
    // exist elsewhere in the deployment by reading the status code.
    auth.current = { accountId: randomUUID(), memberId: alex, role: 'owner' };
    const et = (await createEventType(db, accountId, alex, {
      slug: 'other-account',
      title: 'Other',
      lengthMinutes: 30,
      scheduleId: null,
    })) as { ok: true; value: { id: string } };
    await expect(
      crud.listEventTypeOneOffLinks(REQ, et.value.id),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      crud.createEventTypeOneOffLink(REQ, et.value.id),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      crud.revokeEventTypeOneOffLink(REQ, et.value.id, 'whatever'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('revoke cannot reach a link on an event type other than the one in the path', async () => {
    // THE REGRESSION TEST. The permission check runs against the event type
    // NAMED IN THE PATH, so if the link were addressed by id alone that check
    // would say nothing about the row actually written — and both rows live in
    // the same account, so account scoping alone does not catch it.
    const alexEt = (await createEventType(db, accountId, alex, {
      slug: 'alex-victim',
      title: 'Alex Victim',
      lengthMinutes: 30,
      scheduleId: null,
    })) as { ok: true; value: { id: string } };
    const jordanEt = (await createEventType(db, accountId, jordan, {
      slug: 'jordan-decoy',
      title: 'Jordan Decoy',
      lengthMinutes: 30,
      scheduleId: null,
    })) as { ok: true; value: { id: string } };

    as('owner', alex);
    const victim = await crud.createEventTypeOneOffLink(REQ, alexEt.value.id);

    // Jordan owns `jordanEt` and may revoke on it — but naming Alex's link id
    // must change nothing. 204 either way (revoke is idempotent), so the
    // assertion is on the STATE, not on a thrown error.
    as('member', jordan);
    await crud.revokeEventTypeOneOffLink(REQ, jordanEt.value.id, victim.id);

    as('owner', alex);
    const [still] = await crud.listEventTypeOneOffLinks(REQ, alexEt.value.id);
    expect(still?.state).toBe('live');
    expect(still?.revokedAt).toBeNull();

    // ...and revoking through the RIGHT event type does work.
    await crud.revokeEventTypeOneOffLink(REQ, alexEt.value.id, victim.id);
    const [now] = await crud.listEventTypeOneOffLinks(REQ, alexEt.value.id);
    expect(now?.state).toBe('revoked');
  });
});
