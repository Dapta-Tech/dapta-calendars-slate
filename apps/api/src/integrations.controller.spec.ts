/**
 * Seam F — the three admin routes (H1a / #92). No UI: that is H1b (#93).
 *
 * Two properties carry this file. First, the credential is an ACCOUNT-level
 * resource, so a plain member must not be able to repoint or unplug the
 * workspace's CRM. Second — and this is the one worth a test rather than a code
 * review — NOTHING any route returns carries the token or its ciphertext. A
 * spread instead of an explicit projection would leak it, typecheck cleanly, and
 * be invisible until someone read a network tab.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  createDb,
  migrate,
  seed,
  sql,
  getAccountIntegration,
  type AccountRole,
  type Db,
} from '@slate/db';
import { CrmAuthError, DisabledCrmProvider, type CrmProvider } from '@slate/crm';
import { loadServerEnv, type ServerEnv } from '@slate/config/env';
import { AdminService } from './admin.service';
import { CrmEffects } from './crm-effects';
import { HostController } from './host.controller';
import type { AuthService, HostPrincipal, ReqLike } from './auth.service';

const REQ: ReqLike = { headers: {} };
const KEY_B64 = randomBytes(32).toString('base64');
const TOKEN = 'pat-live-controller-0000-5150';

const ENV: ServerEnv = loadServerEnv({
  NODE_ENV: 'test',
  CRM_PROVIDER: 'hubspot',
  INTEGRATION_ENCRYPTION_KEY: KEY_B64,
} as NodeJS.ProcessEnv);

class FakeAuth {
  current!: HostPrincipal;
  resolveHost(): Promise<HostPrincipal> {
    return Promise.resolve(this.current);
  }
}

/** A CRM whose connect-time probe can be told to reject the credential. */
class ProbeCrm implements CrmProvider {
  readonly enabled = true;
  readonly name = 'hubspot';
  rejectWith: Error | null = null;
  verifyCredential(): Promise<void> {
    return this.rejectWith ? Promise.reject(this.rejectWith) : Promise.resolve();
  }
  resolveContact(): Promise<never> {
    return Promise.reject(new Error('not used'));
  }
  createMeeting(): Promise<never> {
    return Promise.reject(new Error('not used'));
  }
  updateMeeting(): Promise<void> {
    return Promise.resolve();
  }
}

describe('admin integrations routes (H1a, #92)', () => {
  let db: Db;
  let host: HostController;
  let auth: FakeAuth;
  let crm: ProbeCrm;
  let accountId: string;
  let otherAccountId: string;
  let memberId: string;

  function as(role: AccountRole, account = accountId): void {
    auth.current = { memberId, accountId: account, role } as HostPrincipal;
  }

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code = 'acme'`))!.id;
    memberId = (await db.get<{ id: string }>(
      sql`SELECT id FROM member WHERE handle = 'alex-rivera'`,
    ))!.id;
    otherAccountId = 'account-two';
    await db.run(
      sql`INSERT INTO account (id, code, name, created_at)
          VALUES (${otherAccountId}, 'other', 'Other Co', ${Date.now()})`,
    );

    crm = new ProbeCrm();
    const admin = new AdminService(
      db,
      {} as never,
      {} as never,
      undefined,
      undefined,
      ENV,
      new CrmEffects(crm, db, ENV),
    );
    auth = new FakeAuth();
    host = new HostController(admin, {} as never, auth as unknown as AuthService, {} as never);
    as('owner');
  });

  // --- Authorization -------------------------------------------------------

  it('refuses a plain member on every route', async () => {
    as('member');
    await expect(host.listIntegrations(REQ)).rejects.toThrow(ForbiddenException);
    await expect(
      host.connectIntegration(REQ, { provider: 'hubspot', token: TOKEN }),
    ).rejects.toThrow(ForbiddenException);
    await expect(host.disconnectIntegration(REQ, 'hubspot')).rejects.toThrow(ForbiddenException);
  });

  it('allows an admin as well as an owner', async () => {
    as('admin');
    await expect(host.listIntegrations(REQ)).resolves.toEqual([]);
  });

  // --- The credential never comes back ------------------------------------

  it('returns a label and last4, and never the token or the cipher', async () => {
    const connected = await host.connectIntegration(REQ, {
      provider: 'hubspot',
      token: TOKEN,
      label: 'Acme portal',
    });
    for (const payload of [connected, await host.listIntegrations(REQ)]) {
      const json = JSON.stringify(payload);
      expect(json).not.toContain(TOKEN);
      expect(json).not.toContain('v1.');
      expect(json).not.toContain('tokenCipher');
      expect(json).not.toContain('token_cipher');
    }
    expect(connected).toMatchObject({
      provider: 'hubspot',
      status: 'connected',
      label: 'Acme portal',
      tokenLast4: '5150',
    });
  });

  // --- Fail-closed connect -------------------------------------------------

  it('VERIFIES the credential before storing it, and stores nothing when rejected', async () => {
    crm.rejectWith = new CrmAuthError('missing scopes', 403, 'MISSING_SCOPES', [
      'crm.objects.contacts.write',
    ]);
    const err = await host
      .connectIntegration(REQ, { provider: 'hubspot', token: TOKEN })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    // The rejection carries the scope NAME list as DATA (#74), so H1b can name
    // the checkbox rather than saying something went wrong.
    expect((err as UnprocessableEntityException).getResponse()).toMatchObject({
      error: 'INTEGRATION_REJECTED',
      requiredGranularScopes: ['crm.objects.contacts.write'],
      category: 'MISSING_SCOPES',
    });
    // Nothing was written: a credential we could not verify is one we do not keep.
    expect(await getAccountIntegration(db, accountId, 'hubspot')).toBeNull();
  });

  it('stores nothing when the CRM cannot be reached to verify', async () => {
    crm.rejectWith = new Error('network down');
    await expect(
      host.connectIntegration(REQ, { provider: 'hubspot', token: TOKEN }),
    ).rejects.toThrow(BadRequestException);
    expect(await getAccountIntegration(db, accountId, 'hubspot')).toBeNull();
  });

  it('rejects a malformed body with field paths, never echoing the token', async () => {
    const err = await host
      .connectIntegration(REQ, { provider: 'hubspot', token: 'x' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(JSON.stringify((err as BadRequestException).getResponse())).not.toContain('"x"');
  });

  it('refuses a provider this deployment has not enabled', async () => {
    const admin = new AdminService(
      db,
      {} as never,
      {} as never,
      undefined,
      undefined,
      ENV,
      new CrmEffects(new DisabledCrmProvider(), db, ENV),
    );
    const bare = new HostController(admin, {} as never, auth as unknown as AuthService, {} as never);
    const err = await bare
      .connectIntegration(REQ, { provider: 'hubspot', token: TOKEN })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toMatchObject({ error: 'CRM_DISABLED' });
  });

  it('refuses to connect when no encryption key is configured', async () => {
    const admin = new AdminService(
      db,
      {} as never,
      {} as never,
      undefined,
      undefined,
      loadServerEnv({ NODE_ENV: 'test', CRM_PROVIDER: 'hubspot' } as NodeJS.ProcessEnv),
      new CrmEffects(crm, db, ENV),
    );
    const noKey = new HostController(admin, {} as never, auth as unknown as AuthService, {} as never);
    const err = await noKey
      .connectIntegration(REQ, { provider: 'hubspot', token: TOKEN })
      .catch((e: unknown) => e);
    // A CODE, not a bare 500: "the operator has not set a key" and "the CRM is
    // unreachable" need different actions from whoever is looking at the screen.
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err as ServiceUnavailableException).getResponse()).toMatchObject({
      error: 'INTEGRATION_KEY_MISSING',
    });
    expect(await getAccountIntegration(db, accountId, 'hubspot')).toBeNull();
  });

  // --- Disconnect + scoping ------------------------------------------------

  it('disconnects without deleting the row', async () => {
    await host.connectIntegration(REQ, { provider: 'hubspot', token: TOKEN });
    expect(await host.disconnectIntegration(REQ, 'hubspot')).toEqual({ disconnected: true });
    const rows = await host.listIntegrations(REQ);
    expect(rows[0]).toMatchObject({ provider: 'hubspot', status: 'disconnected' });
  });

  it('reports false when there is nothing to disconnect', async () => {
    expect(await host.disconnectIntegration(REQ, 'hubspot')).toEqual({ disconnected: false });
  });

  // Invariant 4: every route is scoped to the resolved principal's account.
  it('cannot see or disconnect another account\'s integration', async () => {
    await host.connectIntegration(REQ, { provider: 'hubspot', token: TOKEN });

    as('owner', otherAccountId);
    expect(await host.listIntegrations(REQ)).toEqual([]);
    expect(await host.disconnectIntegration(REQ, 'hubspot')).toEqual({ disconnected: false });

    as('owner', accountId);
    expect((await host.listIntegrations(REQ))[0]!.status).toBe('connected');
  });
});
