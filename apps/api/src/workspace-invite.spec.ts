import { describe, it, expect, beforeEach } from 'vitest';
import { ForbiddenException, HttpException, NotFoundException } from '@nestjs/common';
import { createDb, membershipsBySubject, migrate, sql, type Db } from '@slate/db';
import {
  BookingNotifier,
  LogOnlyEmailProvider,
  type EmailMessage,
  type EmailProvider,
  type EmailResult,
} from '@slate/notifications';
import type { ServerEnv } from '@slate/config/env';
import { WorkOsAuthProvider } from './auth.provider.workos';
import { AuthService } from './auth.service';
import { AdminCrudController } from './admin-crud.controller';
import { EmailEffects, MEMBER_INVITE_ACTION, OutboxSkipError } from './email-effects';
import { signJwtHs256 } from './jwt';
import type { ReqLike } from './auth.provider';

/**
 * One person, several workspaces, through the production auth path (the
 * platform JWT): an admin invites an address, the invitation email goes out
 * through the outbox, the invitee sees the workspace in their list, accepts it
 * on purpose, and from then on may act in it by naming it (`x-dcal-workspace`).
 * Only memberships this app granted are reachable that way; without the
 * header nothing changes.
 */

const SECRET = 'workspace-invite-test-secret';
const ISS = 'example-identity-service';
const AUD = 'calendar-platform';
const APP = 'https://calendar.example.com';
const DAY = 86_400_000;

function mint(claims: Record<string, unknown>): string {
  const nowSec = Math.floor(Date.now() / 1000);
  return signJwtHs256({ iss: ISS, aud: AUD, iat: nowSec, exp: nowSec + 3600, ...claims }, SECRET);
}

class Capture implements EmailProvider {
  sent: EmailMessage[] = [];
  send(message: EmailMessage): Promise<EmailResult> {
    this.sent.push(message);
    return Promise.resolve({ delivered: true, driver: 'smtp' });
  }
}

const ALEJANDRO = { account_id: 'iam_acct_alejandro', sub: 'iam_user_alejandro', email: 'alejandro@acme.test', name: 'Alejandro', workos_user_id: 'user_01ALE' };
const PABLO = { account_id: 'iam_acct_pablo', sub: 'iam_user_pablo', email: 'Pablo@Acme.test', name: 'Pablo', workos_user_id: 'user_01PAB' };
const OUTSIDER = { account_id: 'iam_acct_outsider', sub: 'iam_user_outsider', email: 'out@else.test', name: 'Outsider' };

describe('workspace invitations: invite, email, list, accept, act', () => {
  let db: Db;
  let capture: Capture;
  let auth: AuthService;
  let email: EmailEffects;
  let crud: AdminCrudController;

  const req = (claims: Record<string, unknown>, workspace?: string): ReqLike => ({
    headers: { authorization: `Bearer ${mint(claims)}`, ...(workspace ? { 'x-dcal-workspace': workspace } : {}) },
  });

  const build = (provider: EmailProvider, mailFromName = 'dCal') => {
    auth = new AuthService(db, new WorkOsAuthProvider(db, { JWT_SECRET: SECRET, JWT_ISSUER: ISS, JWT_AUDIENCE: AUD }));
    email = new EmailEffects(new BookingNotifier(provider), db, provider, {
      PUBLIC_APP_URL: `${APP}/`,
      OUTBOX_POLL_MS: 0,
      MAIL_FROM_NAME: mailFromName,
    } as ServerEnv);
    crud = new AdminCrudController(db, auth, undefined, undefined, undefined, email);
  };

  const inviteRows = () =>
    db.all<{ id: string; action: string; payload: string; account_id: string }>(
      sql`SELECT id, action, payload, account_id FROM outbox WHERE kind = 'email' AND action = ${MEMBER_INVITE_ACTION} ORDER BY created_at ASC, id ASC`,
    );
  const deliverAll = async () => {
    for (const r of await inviteRows()) await email.deliver(r.action, r.payload, r.account_id, 0);
  };
  /** As if a minute had passed since this member's last invitation went out. */
  const openWindow = (id: string) => db.run(sql`UPDATE member SET invited_at = invited_at - 60000 WHERE id = ${id}`);
  const memberInvitedAt = async (id: string) =>
    (await db.get<{ invited_at: number | string | null }>(sql`SELECT invited_at FROM member WHERE id = ${id}`))?.invited_at;
  const memberRow = (id: string) =>
    db.get<{ status: string; external_id: string | null; role: string; login_seen_at: number | string | null }>(
      sql`SELECT status, external_id, role, login_seen_at FROM member WHERE id = ${id}`,
    );

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    capture = new Capture();
    build(capture);
  });

  async function setUp() {
    const alejandro = await auth.resolveHost(req(ALEJANDRO));
    const pablo = await auth.resolveHost(req(PABLO));
    const invited = await crud.inviteMember(req(ALEJANDRO), { email: 'pablo@acme.test', role: 'member', locale: 'es' });
    return { alejandro, pablo, invited };
  }

  it('queues the invitation, in the language asked for, naming the product, linking to the join page', async () => {
    const { alejandro, invited } = await setUp();
    expect(invited).toMatchObject({ status: 'invited', inviteEmail: 'queued' });
    const code = (await db.get<{ code: string }>(sql`SELECT code FROM account WHERE id = ${alejandro.accountId}`))!.code;

    await deliverAll();
    expect(capture.sent).toHaveLength(1);
    const mail = capture.sent[0]!;
    expect(mail.to).toBe('pablo@acme.test');
    expect(mail.subject).toBe('Únete a Alejandro en dCal');
    expect(mail.text).toContain(`${APP}/admin/join/${code}`);
    expect(mail.accountId).toBe(alejandro.accountId);
  });

  it('lists the invitation beside the own account, and nothing changes without the header', async () => {
    const { alejandro, pablo } = await setUp();
    const home = await auth.resolveHost(req(PABLO));
    expect(home).toEqual({ accountId: pablo.accountId, memberId: pablo.memberId, authenticatedAt: expect.any(Number), role: 'owner' });

    // Oldest account first; both were made within the same millisecond or two, so compare as a set.
    const list = await auth.listWorkspaces(req(PABLO));
    expect(list.map((w) => [w.accountId, w.status, w.current, w.home]).sort()).toEqual(
      [
        [alejandro.accountId, 'invited', false, false],
        [pablo.accountId, 'active', true, true],
      ].sort(),
    );
  });

  it('a pending invitation is not acted in until it is accepted on purpose', async () => {
    const { alejandro, invited } = await setUp();
    await expect(auth.resolveHost(req(PABLO, alejandro.accountId))).rejects.toMatchObject({
      response: { error: 'INVITATION_PENDING' },
    });
    expect(await memberRow(invited.id)).toMatchObject({ status: 'invited', external_id: null });

    const accepted = await auth.acceptWorkspace(req(PABLO), alejandro.accountId);
    expect(accepted).toMatchObject({ accountId: alejandro.accountId, status: 'active', role: 'member' });
    expect(await memberRow(invited.id)).toMatchObject({ status: 'active', external_id: PABLO.sub, role: 'member' });
    // Idempotent.
    expect(await auth.acceptWorkspace(req(PABLO), alejandro.accountId)).toMatchObject({ status: 'active' });

    const inside = await auth.resolveHost(req(PABLO, alejandro.accountId));
    expect(inside).toMatchObject({ accountId: alejandro.accountId, memberId: invited.id, role: 'member' });
    // A member, not an admin: the roster stays out of reach.
    await expect(crud.inviteMember(req(PABLO, alejandro.accountId), { email: 'x@acme.test' })).rejects.toThrow();
  });

  it('accepting answers 404 where there is no invitation, and the own account as it is', async () => {
    const { pablo } = await setUp();
    const outsider = await auth.resolveHost(req(OUTSIDER));
    await expect(auth.acceptWorkspace(req(PABLO), outsider.accountId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(auth.acceptWorkspace(req(PABLO), 'no-such-account')).rejects.toBeInstanceOf(NotFoundException);
    expect(await auth.acceptWorkspace(req(PABLO), pablo.accountId)).toMatchObject({ home: true, status: 'active' });
  });

  it('the MCP door sees the joined workspace once the person acts in it', async () => {
    const { alejandro, pablo } = await setUp();
    await auth.acceptWorkspace(req(PABLO), alejandro.accountId);
    await auth.resolveHost(req(PABLO, alejandro.accountId));
    const seen = await membershipsBySubject(db, PABLO.workos_user_id, Date.now() - DAY);
    expect(seen.map((m) => m.accountId).sort()).toEqual([alejandro.accountId, pablo.accountId].sort());
  });

  it('never honors, from another account’s token, a membership a token for that account created', async () => {
    // Pablo once held a token for Alejandro's account (an upstream switch): the
    // provider made him a member there. Upstream then removes him, which this
    // app is never told; the identity service will not mint that token again.
    const alejandro = await auth.resolveHost(req(ALEJANDRO));
    const viaToken = await auth.resolveHost(req({ ...PABLO, account_id: ALEJANDRO.account_id }));
    expect(viaToken.accountId).toBe(alejandro.accountId);
    await db.run(sql`UPDATE member SET login_seen_at = ${Date.now() - 40 * DAY} WHERE id = ${viaToken.memberId}`);
    const before = (await memberRow(viaToken.memberId))!.login_seen_at;

    await auth.resolveHost(req(PABLO));
    await expect(auth.resolveHost(req(PABLO, alejandro.accountId))).rejects.toMatchObject({
      response: { error: 'WORKSPACE_FORBIDDEN' },
    });
    expect((await memberRow(viaToken.memberId))!.login_seen_at).toBe(before);
    expect((await auth.listWorkspaces(req(PABLO))).map((w) => w.accountId)).not.toContain(alejandro.accountId);
    await expect(auth.acceptWorkspace(req(PABLO), alejandro.accountId)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses a workspace the person holds no membership in, never falling back to home', async () => {
    const { alejandro } = await setUp();
    const outsider = await auth.resolveHost(req(OUTSIDER));
    await expect(auth.resolveHost(req(PABLO, outsider.accountId))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(auth.resolveHost(req(OUTSIDER, alejandro.accountId))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(auth.resolveHost(req(PABLO, 'no-such-account'))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('naming the home account is the same as naming none', async () => {
    const { pablo } = await setUp();
    expect(await auth.resolveHost(req(PABLO, pablo.accountId))).toMatchObject({ accountId: pablo.accountId, role: 'owner' });
  });

  it('consent speaks for the home account whatever workspace is named', async () => {
    const { alejandro, pablo } = await setUp();
    await auth.acceptWorkspace(req(PABLO), alejandro.accountId);
    expect(await auth.resolveHost(req(PABLO, alejandro.accountId), { workspace: false })).toMatchObject({
      accountId: pablo.accountId,
      role: 'owner',
    });
  });

  it('refuses a membership that was disabled or removed', async () => {
    const { alejandro, invited } = await setUp();
    await auth.acceptWorkspace(req(PABLO), alejandro.accountId);
    await db.run(sql`UPDATE member SET status = 'disabled' WHERE id = ${invited.id}`);
    await expect(auth.resolveHost(req(PABLO, alejandro.accountId))).rejects.toBeInstanceOf(ForbiddenException);
    expect((await auth.listWorkspaces(req(PABLO))).map((w) => w.accountId)).not.toContain(alejandro.accountId);
  });

  it('finds the invitation by the address the token vouches for, not a stale stored one', async () => {
    const alejandro = await auth.resolveHost(req(ALEJANDRO));
    await auth.resolveHost(req({ ...PABLO, email: 'old@acme.test' }));
    await crud.inviteMember(req(ALEJANDRO), { email: 'new@acme.test' });
    const withNew = await auth.listWorkspaces(req({ ...PABLO, email: 'New@Acme.test' }));
    expect(withNew.map((w) => w.accountId)).toContain(alejandro.accountId);
    // An address the identity service marks unverified claims nothing.
    const unverified = await auth.listWorkspaces(req({ ...PABLO, email: 'new@acme.test', email_verified: false }));
    expect(unverified.map((w) => w.accountId)).not.toContain(alejandro.accountId);
  });

  it('resends a pending invitation, at most once a minute, and only while it is pending', async () => {
    const { alejandro, invited } = await setUp();
    // The first send counts: an immediate resend is refused.
    await expect(crud.resendInvite(req(ALEJANDRO), invited.id, {})).rejects.toMatchObject({ status: 429 });
    // A restart does not reopen it: the window lives in the database.
    build(capture);
    await expect(crud.resendInvite(req(ALEJANDRO), invited.id, {})).rejects.toMatchObject({ status: 429 });

    await openWindow(invited.id);
    const again = await crud.resendInvite(req(ALEJANDRO), invited.id, { locale: 'en' });
    expect(again).toEqual({ ok: true, inviteEmail: 'queued' });
    await deliverAll();
    expect(capture.sent.map((m) => m.subject)).toEqual(['Únete a Alejandro en dCal', 'Join Alejandro on dCal']);
    expect(new Set(capture.sent.map((m) => m.idempotencyKey)).size).toBe(2);

    await auth.acceptWorkspace(req(PABLO), alejandro.accountId);
    await openWindow(invited.id);
    await expect(crud.resendInvite(req(ALEJANDRO), invited.id, {})).rejects.toMatchObject({ status: 409 });
  });

  it('two replicas resending at once queue one email', async () => {
    const { invited } = await setUp();
    await openWindow(invited.id);
    // Two instances of the app on one database, as prd runs them.
    const replicaA = crud;
    build(capture);
    const replicaB = crud;
    const results = await Promise.allSettled([
      replicaA.resendInvite(req(ALEJANDRO), invited.id, {}),
      replicaB.resendInvite(req(ALEJANDRO), invited.id, {}),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected' && (r.reason as HttpException).getStatus() === 429)).toHaveLength(1);
    expect(await inviteRows()).toHaveLength(2); // the first invitation and one resend
  });

  it('a send that could not be queued reopens the window', async () => {
    const { invited } = await setUp();
    await openWindow(invited.id);
    const windowBefore = Number((await memberInvitedAt(invited.id))!);
    await db.run(sql`ALTER TABLE outbox RENAME TO outbox_away`);
    try {
      expect(await crud.resendInvite(req(ALEJANDRO), invited.id, {})).toEqual({ ok: true, inviteEmail: 'failed' });
    } finally {
      await db.run(sql`ALTER TABLE outbox_away RENAME TO outbox`);
    }
    expect(Number(await memberInvitedAt(invited.id))).toBe(windowBefore);
    expect(await crud.resendInvite(req(ALEJANDRO), invited.id, {})).toEqual({ ok: true, inviteEmail: 'queued' });
  });

  it('caps invitation emails per workspace per day, in the database, and deleting members gives nothing back', async () => {
    await auth.resolveHost(req(ALEJANDRO));
    const ids: string[] = [];
    for (let i = 0; i < 49; i += 1) ids.push((await crud.inviteMember(req(ALEJANDRO), { email: `p${i}@acme.test` })).id);
    // A refused invite (the address is already there) does not spend the allowance.
    await expect(crud.inviteMember(req(ALEJANDRO), { email: 'p0@acme.test' })).rejects.toThrow();
    // A resend does.
    await openWindow(ids[0]!);
    await crud.resendInvite(req(ALEJANDRO), ids[0]!, {});
    await expect(crud.inviteMember(req(ALEJANDRO), { email: 'p50@acme.test' })).rejects.toMatchObject({
      status: 429,
      response: { error: 'INVITE_LIMIT' },
    });
    await db.run(sql`DELETE FROM member WHERE email LIKE 'p%@acme.test'`);
    await expect(crud.inviteMember(req(ALEJANDRO), { email: 'p51@acme.test' })).rejects.toMatchObject({ status: 429 });
  });

  it('lists the person’s workspaces even when the chosen one was taken away', async () => {
    const { alejandro, pablo, invited } = await setUp();
    await auth.acceptWorkspace(req(PABLO), alejandro.accountId);
    await db.run(sql`UPDATE member SET status = 'disabled' WHERE id = ${invited.id}`);
    const list = await auth.listWorkspaces(req(PABLO, alejandro.accountId));
    expect(list.map((w) => [w.accountId, w.current])).toEqual([[pablo.accountId, false]]);
  });

  it('skips a queued invitation once the member joined or was removed; the send keeps its share of the allowance', async () => {
    const { alejandro, invited } = await setUp();
    const sent = async () =>
      Number((await db.get<{ sent: number | string }>(sql`SELECT sent FROM member_invite_quota WHERE account_id = ${alejandro.accountId}`))?.sent ?? 0);
    expect(await sent()).toBe(1);
    await auth.acceptWorkspace(req(PABLO), alejandro.accountId);
    const [row] = await inviteRows();
    await expect(email.deliver(row!.action, row!.payload, row!.account_id, 0)).rejects.toBeInstanceOf(OutboxSkipError);
    // A skip retried by the worker can never give it back twice: it gives nothing back.
    expect(await sent()).toBe(1);

    await db.run(sql`DELETE FROM member WHERE id = ${invited.id}`);
    await expect(email.deliver(row!.action, row!.payload, row!.account_id, 0)).rejects.toBeInstanceOf(OutboxSkipError);
    expect(capture.sent).toHaveLength(0);
  });

  it('says "off" when this deployment sends no mail, and names no product it was not given', async () => {
    build(new LogOnlyEmailProvider(), ''); // a deployment that names no product
    await auth.resolveHost(req(ALEJANDRO));
    const invited = await crud.inviteMember(req(ALEJANDRO), { email: 'pablo@acme.test' });
    expect(invited).toMatchObject({ status: 'invited', inviteEmail: 'off' });
    const [row] = await inviteRows();
    expect(JSON.parse(row!.payload)).toMatchObject({ productName: null });
  });

  it('only an admin can resend', async () => {
    const { alejandro } = await setUp();
    await auth.acceptWorkspace(req(PABLO), alejandro.accountId);
    const other = await crud.inviteMember(req(ALEJANDRO), { email: 'third@acme.test' });
    build(capture);
    await expect(crud.resendInvite(req(PABLO, alejandro.accountId), other.id, {})).rejects.toBeInstanceOf(HttpException);
  });
});
