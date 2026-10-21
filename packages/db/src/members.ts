/**
 * Account-level member management — the workspace roster the dashboard's
 * Members/Staff page drives: list members with their role + status, invite by
 * email, change role, enable/disable, remove.
 *
 * This is the ACCOUNT role (`member.role`: owner | admin | member), distinct from
 * the per-team role (`team_membership.role`) even though the two share value
 * names. Every account keeps at least one owner (last-owner guard, mirroring the
 * team owner-protection in crud.ts). All ops are account-scoped by the caller.
 */
import { randomUUID } from 'node:crypto';
import { sql, type Db } from './client';
import type { CrudResult } from './crud';
import { deriveUniqueHandle } from './short-links';
import { jsonParam } from './repository';

/** Account-level roles, most-privileged first. */
export const ACCOUNT_ROLES = ['owner', 'admin', 'member'] as const;
export type AccountRole = (typeof ACCOUNT_ROLES)[number];

/** Member lifecycle within a workspace. */
export const MEMBER_STATUSES = ['active', 'invited', 'disabled'] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

export interface MemberView {
  id: string;
  email: string | null;
  displayName: string | null;
  handle: string | null;
  avatarUrl: string | null;
  role: AccountRole;
  status: MemberStatus;
  createdAt: number;
}

interface MemberDbRow {
  id: string;
  email: string | null;
  display_name: string | null;
  handle: string | null;
  avatar_url: string | null;
  role: string;
  status: string;
  created_at: number;
}

function toMemberView(r: MemberDbRow): MemberView {
  return {
    id: r.id,
    email: r.email,
    displayName: r.display_name,
    handle: r.handle,
    avatarUrl: r.avatar_url,
    role: (r.role as AccountRole) ?? 'member',
    status: (r.status as MemberStatus) ?? 'active',
    createdAt: r.created_at,
  };
}

const MEMBER_COLS = sql`id, email, display_name, handle, avatar_url, role, status, created_at`;

/** All members of an account, oldest first (owner typically leads). */
export async function listMembers(db: Db, accountId: string): Promise<MemberView[]> {
  const rows = await db.all<MemberDbRow>(
    sql`SELECT ${MEMBER_COLS} FROM member WHERE account_id = ${accountId} ORDER BY created_at ASC, id ASC`,
  );
  return rows.map(toMemberView);
}

/** A single account member (scoped) — used by the permission layer + PATCH/DELETE. */
export async function getAccountMember(
  db: Db,
  accountId: string,
  memberId: string,
): Promise<MemberView | null> {
  const r = await db.get<MemberDbRow>(
    sql`SELECT ${MEMBER_COLS} FROM member WHERE account_id = ${accountId} AND id = ${memberId} LIMIT 1`,
  );
  return r ? toMemberView(r) : null;
}

/**
 * The caller's account role, or null if the member is unknown/foreign. The
 * permission layer resolves this from the AuthProvider principal's memberId.
 */
export async function getMemberRole(
  db: Db,
  accountId: string,
  memberId: string,
): Promise<AccountRole | null> {
  const r = await db.get<{ role: string }>(
    sql`SELECT role FROM member WHERE account_id = ${accountId} AND id = ${memberId} LIMIT 1`,
  );
  return r ? ((r.role as AccountRole) ?? 'member') : null;
}

/** Count active owners other than `excludeMemberId` (for the last-owner guard). */
async function otherActiveOwners(
  db: Db,
  accountId: string,
  excludeMemberId: string,
): Promise<number> {
  const row = await db.get<{ n: number }>(
    sql`SELECT COUNT(*) AS n FROM member
        WHERE account_id = ${accountId} AND role = 'owner' AND status = 'active'
          AND id <> ${excludeMemberId}`,
  );
  return Number(row?.n ?? 0);
}

const EMAIL_LOCAL = (email: string) => email.split('@')[0] ?? email;

/**
 * Invite a member by email → creates an `invited` member row with the given role
 * so they can be granted access before they ever sign in. An owner cannot be
 * invited (ownership is transferred, never handed out). A repeat email in the
 * same account is refused (EMAIL_TAKEN) rather than creating a duplicate.
 */
export async function inviteMember(
  db: Db,
  accountId: string,
  input: { email: string; role?: 'admin' | 'member'; displayName?: string | null },
  /**
   * The booking-page branding the new member is born with. The caller supplies
   * it (`withNewHostBranding` in `@slate/shared`) because this package does not
   * own the design language; absent, the row stores none, as it always did.
   */
  branding?: { brandColor: string | null; style: Record<string, unknown> | null },
): Promise<CrudResult<MemberView>> {
  const email = input.email.trim().toLowerCase();
  if (!email) return { ok: false, reason: 'CONFLICT', message: 'An email is required.' };
  const role: AccountRole = input.role === 'admin' ? 'admin' : 'member';

  const clash = await db.get<{ id: string }>(
    sql`SELECT id FROM member WHERE account_id = ${accountId} AND lower(email) = ${email} LIMIT 1`,
  );
  if (clash)
    return { ok: false, reason: 'EMAIL_TAKEN', message: 'A member with that email already exists.' };

  const id = randomUUID();
  const now = Date.now();
  // Auto-handle at creation (short-links §3): invited members are bookable the
  // moment they accept — no "set a handle" step, freely renameable later.
  const handle = await deriveUniqueHandle(db, accountId, input.displayName, email);
  await db.run(
    // `invited_at` marks the membership as one THIS app granted: the only kind a
    // request may act in by naming the account (`workspaces.ts`, ADR 0010).
    sql`INSERT INTO member (id, account_id, email, display_name, handle, role, status, brand_color, booking_page_style, created_at, invited_at)
        VALUES (${id}, ${accountId}, ${email}, ${input.displayName ?? EMAIL_LOCAL(email)},
          ${handle}, ${role}, ${'invited'}, ${branding?.brandColor ?? null},
          ${jsonParam(db, branding?.style ?? null)}, ${now}, ${now})`,
  );
  return { ok: true, value: (await getAccountMember(db, accountId, id))! };
}

/**
 * A claim on one member's invitation send: when it was taken, and the value
 * that reopens the window if it is handed back (a minute earlier, so the next
 * send may go at once).
 */
export interface InvitationSendClaim {
  at: number;
  reopen: number;
}

/**
 * Claim this member's one invitation send per `windowMs`, shared by every
 * instance of the app: one conditional UPDATE of `member.invited_at` (when an
 * invitation to this member last went out), so two requests on two replicas, or
 * one before and one after a restart, cannot both pass. The claim is handed
 * back with `releaseInvitationSend` when the send is not queued.
 *
 * Only a row that already carries `invited_at` can be claimed: that column is
 * also what marks a membership as one this app granted (ADR 0010), so a send
 * must never be what creates it. A member set back to `invited` by hand, who
 * never came from an invitation, has nothing to claim.
 *
 * Null when the window is still closed, the member is no longer a pending
 * invitation, or the row never came from one.
 */
export async function claimInvitationSend(
  db: Db,
  accountId: string,
  memberId: string,
  windowMs: number,
  nowMs: number = Date.now(),
): Promise<InvitationSendClaim | null> {
  const row = await db.get<{ id: string }>(
    sql`UPDATE member SET invited_at = ${nowMs}
        WHERE id = ${memberId} AND account_id = ${accountId} AND status = 'invited'
          AND invited_at IS NOT NULL AND invited_at <= ${nowMs - windowMs}
        RETURNING id`,
  );
  return row ? { at: nowMs, reopen: nowMs - windowMs } : null;
}

/**
 * The claim on the send an invitation's creation just made: the row was written
 * with `invited_at` = now, which already closes the window. Handing it back opens
 * the window again, for a first send that could not be queued.
 */
export function creationSendClaim(invitedAt: number, windowMs: number): InvitationSendClaim {
  return { at: invitedAt, reopen: invitedAt - windowMs };
}

/**
 * Hand back a claim whose send was not queued: compare, then reopen, so a later
 * claim (another request, after this window) is never undone. The value written
 * is never NULL: the row keeps its mark.
 */
export async function releaseInvitationSend(db: Db, accountId: string, memberId: string, claim: InvitationSendClaim): Promise<void> {
  await db.run(
    sql`UPDATE member SET invited_at = ${claim.reopen}
        WHERE id = ${memberId} AND account_id = ${accountId} AND invited_at = ${claim.at}`,
  );
}

/** The UTC day an invitation email counts against (`member_invite_quota.day`, migration 0032 / sqlite 0031). */
function quotaDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * Take one invitation email (new or resent) from the account's daily allowance:
 * one atomic conditional upsert, so concurrent requests cannot all slip under
 * the cap, in a table of its own, so deleting members gives nothing back. True
 * when the send fits within `cap`. A refused send changes nothing (the update
 * only applies below the cap and then returns no row), so a later refund always
 * reopens exactly one slot.
 */
export async function takeInvitationQuota(db: Db, accountId: string, cap: number, nowMs: number = Date.now()): Promise<boolean> {
  if (cap < 1) return false;
  const day = quotaDay(nowMs);
  const row = await db.get<{ sent: number | string }>(
    sql`INSERT INTO member_invite_quota (account_id, day, sent) VALUES (${accountId}, ${day}, 1)
        ON CONFLICT (account_id, day) DO UPDATE SET sent = member_invite_quota.sent + 1
        WHERE member_invite_quota.sent < ${cap}
        RETURNING sent`,
  );
  return row !== undefined && row !== null;
}

/** Give back one send taken by `takeInvitationQuota` whose email never went out (the invite was refused). */
export async function refundInvitationQuota(db: Db, accountId: string, nowMs: number = Date.now()): Promise<void> {
  await db.run(
    sql`UPDATE member_invite_quota SET sent = sent - 1
        WHERE account_id = ${accountId} AND day = ${quotaDay(nowMs)} AND sent > 0`,
  );
}

/**
 * Change a member's account role. Guards the last owner: demoting the sole active
 * owner would leave the workspace ownerless (LAST_OWNER). Promoting to owner is
 * allowed (co-owners), mirroring the team owner model.
 */
export async function changeMemberRole(
  db: Db,
  accountId: string,
  memberId: string,
  role: AccountRole,
): Promise<CrudResult<MemberView>> {
  if (!ACCOUNT_ROLES.includes(role))
    return { ok: false, reason: 'CONFLICT', message: 'Unknown role.' };
  const current = await getAccountMember(db, accountId, memberId);
  if (!current) return { ok: false, reason: 'NOT_FOUND' };
  if (current.role === role) return { ok: true, value: current };

  if (current.role === 'owner' && role !== 'owner') {
    if ((await otherActiveOwners(db, accountId, memberId)) === 0)
      return { ok: false, reason: 'LAST_OWNER', message: 'A workspace must keep at least one owner.' };
  }
  await db.run(sql`UPDATE member SET role = ${role} WHERE account_id = ${accountId} AND id = ${memberId}`);
  return { ok: true, value: (await getAccountMember(db, accountId, memberId))! };
}

/**
 * Hand the workspace to another member: the target becomes owner, the current
 * owner steps down to admin. Single-owner model (QA2 fix 6b) — ownership moves
 * only through this explicit flow, never the role dropdown. The target must be
 * an ACTIVE member: an invited/disabled owner couldn't administer anything,
 * and the workspace would be ownerless in practice.
 */
export async function transferOwnership(
  db: Db,
  accountId: string,
  fromMemberId: string,
  toMemberId: string,
): Promise<CrudResult<MemberView>> {
  if (fromMemberId === toMemberId)
    return { ok: false, reason: 'CONFLICT', message: 'You already own this workspace.' };
  const target = await getAccountMember(db, accountId, toMemberId);
  if (!target) return { ok: false, reason: 'NOT_FOUND' };
  if (target.status !== 'active')
    return {
      ok: false,
      reason: 'CONFLICT',
      message: 'Ownership can only be transferred to an active member.',
    };
  await db.run(
    sql`UPDATE member SET role = 'owner' WHERE account_id = ${accountId} AND id = ${toMemberId}`,
  );
  await db.run(
    sql`UPDATE member SET role = 'admin' WHERE account_id = ${accountId} AND id = ${fromMemberId}`,
  );
  return { ok: true, value: (await getAccountMember(db, accountId, toMemberId))! };
}

/**
 * Enable/disable a member (soft access revocation). Disabling an owner is guarded
 * the same as demotion — the account must retain an active owner.
 */
export async function setMemberStatus(
  db: Db,
  accountId: string,
  memberId: string,
  status: MemberStatus,
): Promise<CrudResult<MemberView>> {
  if (!MEMBER_STATUSES.includes(status))
    return { ok: false, reason: 'CONFLICT', message: 'Unknown status.' };
  const current = await getAccountMember(db, accountId, memberId);
  if (!current) return { ok: false, reason: 'NOT_FOUND' };
  if (current.role === 'owner' && status !== 'active') {
    if ((await otherActiveOwners(db, accountId, memberId)) === 0)
      return { ok: false, reason: 'LAST_OWNER', message: 'A workspace must keep at least one owner.' };
  }
  await db.run(
    sql`UPDATE member SET status = ${status} WHERE account_id = ${accountId} AND id = ${memberId}`,
  );
  return { ok: true, value: (await getAccountMember(db, accountId, memberId))! };
}

/**
 * Remove a member from the workspace. Guards the last owner. Cascades the
 * member's personal resources (schedules + availability, own event-types + their
 * host rows, host memberships in team events, connected calendars, slot holds,
 * team memberships, own webhooks). Historical bookings are kept (host_member_id
 * left intact as a record).
 */
export async function removeMember(
  db: Db,
  accountId: string,
  memberId: string,
): Promise<CrudResult<{ id: string }>> {
  const current = await getAccountMember(db, accountId, memberId);
  if (!current) return { ok: true, value: { id: memberId } }; // already gone — idempotent
  if (current.role === 'owner') {
    if ((await otherActiveOwners(db, accountId, memberId)) === 0)
      return { ok: false, reason: 'LAST_OWNER', message: 'A workspace must keep at least one owner.' };
  }

  // Availability rows hang off the member's schedules — delete them first.
  await db.run(
    sql`DELETE FROM availability WHERE schedule_id IN
          (SELECT id FROM schedule WHERE account_id = ${accountId} AND member_id = ${memberId})`,
  );
  await db.run(sql`DELETE FROM schedule WHERE account_id = ${accountId} AND member_id = ${memberId}`);
  // Host rows: both the member's own event-types and their seat in team events.
  await db.run(
    sql`DELETE FROM event_type_host WHERE account_id = ${accountId}
          AND (member_id = ${memberId}
            OR event_type_id IN (SELECT id FROM event_type WHERE account_id = ${accountId} AND member_id = ${memberId}))`,
  );
  await db.run(sql`DELETE FROM event_type WHERE account_id = ${accountId} AND member_id = ${memberId}`);
  await db.run(sql`DELETE FROM connected_calendar WHERE account_id = ${accountId} AND member_id = ${memberId}`);
  await db.run(sql`DELETE FROM slot_reservation WHERE account_id = ${accountId} AND member_id = ${memberId}`);
  await db.run(sql`DELETE FROM team_membership WHERE account_id = ${accountId} AND member_id = ${memberId}`);
  await db.run(sql`DELETE FROM webhook WHERE account_id = ${accountId} AND member_id = ${memberId}`);
  await db.run(sql`DELETE FROM member WHERE account_id = ${accountId} AND id = ${memberId}`);
  return { ok: true, value: { id: memberId } };
}
