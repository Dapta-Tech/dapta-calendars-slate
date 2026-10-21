import { describe, it, expect, beforeEach } from 'vitest';
import { ForbiddenException, HttpException } from '@nestjs/common';
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
 * through the outbox, the invitee sees the workspace in their list, and acting
 * in it (the `x-dcal-workspace` header) is accepting it. Without the header
 * nothing changes.
 */

const SECRET = 'workspace-invite-test-secret';
const ISS = 'example-identity-service';
const AUD = 'calendar-platform';
const APP = 'https://calendar.example.com';

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

describe('workspace invitations: invite, email, list, enter = accept', () => {
  let db: Db;
  let capture: Capture;
  let auth: AuthService;
  let email: EmailEffects;
  let crud: AdminCrudController;

  const req = (claims: Record<string, unknown>, workspace?: string): ReqLike => ({
    headers: { authorization: `Bearer ${mint(claims)}`, ...(workspace ? { 'x-dcal-workspace': workspace } : {}) },
  });

  const build = (provider: EmailProvider) => {
    auth = new AuthService(db, new WorkOsAuthProvider(db, { JWT_SECRET: SECRET, JWT_ISSUER: ISS, JWT_AUDIENCE: AUD }));
    email = new EmailEffects(new BookingNotifier(provider), db, provider, { PUBLIC_APP_URL: `${APP}/`, OUTBOX_POLL_MS: 0 } as ServerEnv);
    crud = new AdminCrudController(db, auth, undefined, undefined, undefined, email);
  };

  const inviteRows = () =>
    db.all<{ id: string; action: string; payload: string; account_id: string }>(
      sql`SELECT id, action, payload, account_id FROM outbox WHERE kind = 'email' AND action = ${MEMBER_INVITE_ACTION} ORDER BY created_at ASC, id ASC`,
    );
  const deliverAll = async () => {
    for (const r of await inviteRows()) await email.deliver(r.action, r.payload, r.account_id, 0);
  };
  const memberRow = (id: string) =>
    db.get<{ status: string; external_id: string | null; role: string }>(sql`SELECT status, external_id, role FROM member WHERE id = ${id}`);

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

  it('queues the invitation, in the language asked for, with a link to the workspace', async () => {
    const { alejandro, invited } = await setUp();
    expect(invited).toMatchObject({ status: 'invited', inviteEmail: 'queued' });
    const code = (await db.get<{ code: string }>(sql`SELECT code FROM account WHERE id = ${alejandro.accountId}`))!.code;

    await deliverAll();
    expect(capture.sent).toHaveLength(1);
    const mail = capture.sent[0]!;
    expect(mail.to).toBe('pablo@acme.test');
    expect(mail.subject).toBe(`Alejandro te invitó a Alejandro`);
    expect(mail.text).toContain(`${APP}/invite/${code}`);
    expect(mail.accountId).toBe(alejandro.accountId);
  });

  it('lists the invitation beside the own account, and nothing changes without the header', async () => {
    const { alejandro, pablo } = await setUp();
    const home = await auth.resolveHost(req(PABLO));
    expect(home).toMatchObject({ accountId: pablo.accountId, memberId: pablo.memberId, role: 'owner' });

    const list = await auth.listWorkspaces(req(PABLO));
    expect(list.map((w) => [w.accountId, w.status, w.current, w.home])).toEqual([
      [alejandro.accountId, 'invited', false, false],
      [pablo.accountId, 'active', true, true],
    ]);
  });

  it('acting in the invited workspace accepts it, binds it to the person, and keeps the invited role', async () => {
    const { alejandro, invited } = await setUp();
    const inside = await auth.resolveHost(req(PABLO, alejandro.accountId));
    expect(inside).toMatchObject({ accountId: alejandro.accountId, memberId: invited.id, role: 'member' });
    expect(await memberRow(invited.id)).toEqual({ status: 'active', external_id: PABLO.sub, role: 'member' });

    const list = await auth.listWorkspaces(req(PABLO, alejandro.accountId));
    expect(list.find((w) => w.accountId === alejandro.accountId)).toMatchObject({ status: 'active', current: true });
    // A member, not an admin: the roster stays out of reach.
    await expect(crud.inviteMember(req(PABLO, alejandro.accountId), { email: 'x@acme.test' })).rejects.toThrow();
  });

  it('the MCP door sees the joined workspace once the person has acted in it', async () => {
    const { alejandro } = await setUp();
    await auth.resolveHost(req(PABLO, alejandro.accountId));
    const seen = await membershipsBySubject(db, PABLO.workos_user_id, Date.now() - 86_400_000);
    expect(seen.map((m) => m.accountId).sort()).toEqual([alejandro.accountId, (await auth.resolveHost(req(PABLO))).accountId].sort());
  });

  it('refuses a workspace the person holds no membership in, never falling back to home', async () => {
    const { alejandro } = await setUp();
    const outsider = await auth.resolveHost(req(OUTSIDER));
    await expect(auth.resolveHost(req(PABLO, outsider.accountId))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(auth.resolveHost(req(OUTSIDER, alejandro.accountId))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(auth.resolveHost(req(PABLO, 'no-such-account'))).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses a membership that was disabled or removed', async () => {
    const { alejandro, invited } = await setUp();
    await auth.resolveHost(req(PABLO, alejandro.accountId));
    await db.run(sql`UPDATE member SET status = 'disabled' WHERE id = ${invited.id}`);
    await expect(auth.resolveHost(req(PABLO, alejandro.accountId))).rejects.toBeInstanceOf(ForbiddenException);
    expect((await auth.listWorkspaces(req(PABLO))).map((w) => w.accountId)).not.toContain(alejandro.accountId);
  });

  it('resends a pending invitation, at most once a minute, and only while it is pending', async () => {
    const { alejandro, invited } = await setUp();
    // The first send counts: an immediate resend is refused.
    await expect(crud.resendInvite(req(ALEJANDRO), invited.id, {})).rejects.toMatchObject({ status: 429 });

    build(capture); // a fresh process: the window starts over
    const again = await crud.resendInvite(req(ALEJANDRO), invited.id, { locale: 'en' });
    expect(again).toEqual({ ok: true, inviteEmail: 'queued' });
    await deliverAll();
    expect(capture.sent.map((m) => m.subject)).toEqual(['Alejandro te invitó a Alejandro', 'Alejandro invited you to Alejandro']);
    expect(new Set(capture.sent.map((m) => m.idempotencyKey)).size).toBe(2);

    await auth.resolveHost(req(PABLO, alejandro.accountId));
    build(capture);
    await expect(crud.resendInvite(req(ALEJANDRO), invited.id, {})).rejects.toMatchObject({ status: 409 });
  });

  it('skips a queued invitation once the member joined or was removed', async () => {
    const { alejandro, invited } = await setUp();
    await auth.resolveHost(req(PABLO, alejandro.accountId));
    const [row] = await inviteRows();
    await expect(email.deliver(row!.action, row!.payload, row!.account_id, 0)).rejects.toBeInstanceOf(OutboxSkipError);

    await db.run(sql`DELETE FROM member WHERE id = ${invited.id}`);
    await expect(email.deliver(row!.action, row!.payload, row!.account_id, 0)).rejects.toBeInstanceOf(OutboxSkipError);
    expect(capture.sent).toHaveLength(0);
  });

  it('says "off" when this deployment sends no mail', async () => {
    build(new LogOnlyEmailProvider());
    await auth.resolveHost(req(ALEJANDRO));
    const invited = await crud.inviteMember(req(ALEJANDRO), { email: 'pablo@acme.test' });
    expect(invited).toMatchObject({ status: 'invited', inviteEmail: 'off' });
  });

  it('only an admin can resend', async () => {
    const { alejandro, invited } = await setUp();
    await auth.resolveHost(req(PABLO, alejandro.accountId));
    const other = await crud.inviteMember(req(ALEJANDRO), { email: 'third@acme.test' });
    build(capture);
    await expect(crud.resendInvite(req(PABLO, alejandro.accountId), other.id, {})).rejects.toBeInstanceOf(HttpException);
    expect(invited.id).not.toBe(other.id);
  });
});
