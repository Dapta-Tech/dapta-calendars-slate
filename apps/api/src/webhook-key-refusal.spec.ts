/**
 * W (#75) — the WRITE contract at the service boundary.
 *
 * Creating a webhook mints a signing secret, so it cannot proceed without a key
 * to seal it with. That refusal is the one behavior change this unit makes to a
 * bare clone-and-run fork, and it has to be a CODE rather than a bare 500: the
 * dashboard tells the host to go ask their operator for
 * `INTEGRATION_ENCRYPTION_KEY`, and it can only do that if it can tell this
 * apart from a rejected URL.
 *
 * Its CRM twin is covered in `integrations.controller.spec.ts`; this file is the
 * webhook half, plus the case that one collapsed for a long time — a key that is
 * SET but malformed must not be reported as "not configured".
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { ServiceUnavailableException } from '@nestjs/common';
import { createDb, migrate, seed, sql, listWebhooks, type Db } from '@slate/db';
import { loadServerEnv } from '@slate/config/env';
import { AdminService } from './admin.service';
import type { HostPrincipal } from './auth.service';

const KEY_B64 = randomBytes(32).toString('base64');

function makeAdmin(env: Record<string, string | undefined>, db: Db): AdminService {
  return new AdminService(
    db,
    {} as never,
    {} as never,
    undefined,
    undefined,
    loadServerEnv({ NODE_ENV: 'test', ...env } as NodeJS.ProcessEnv),
  );
}

describe('creating a webhook needs a usable encryption key (W, #75)', () => {
  let db: Db;
  let p: HostPrincipal;

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    const account = await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code='acme'`);
    const member = await db.get<{ id: string }>(
      sql`SELECT id FROM member WHERE account_id = ${account!.id} ORDER BY created_at ASC LIMIT 1`,
    );
    p = { accountId: account!.id, memberId: member!.id, role: 'owner' } as HostPrincipal;
  });

  const body = { subscriberUrl: 'https://198.51.100.10/hook', eventTriggers: ['booking.created'] };

  it('refuses with a coded 503 when no key is configured, and writes nothing', async () => {
    const admin = makeAdmin({}, db);
    const err = await Promise.resolve()
      .then(() => admin.createWebhook(p, body))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect((err as ServiceUnavailableException).getResponse()).toMatchObject({
      error: 'INTEGRATION_KEY_MISSING',
    });
    // Refused means refused: no half-written row, plaintext or otherwise.
    expect(await listWebhooks(db, p.accountId)).toHaveLength(0);
  });

  it('says the key is MALFORMED when it is set but not 32 bytes, not "not configured"', async () => {
    const admin = makeAdmin({ INTEGRATION_ENCRYPTION_KEY: randomBytes(16).toString('base64') }, db);
    const err = await Promise.resolve()
      .then(() => admin.createWebhook(p, body))
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ServiceUnavailableException);
    const res = (err as ServiceUnavailableException).getResponse() as {
      error: string;
      message: string;
    };
    expect(res.error).toBe('INTEGRATION_KEY_MISSING');
    // The distinction that matters: it IS configured, so sending the operator to
    // set it would send them to fix the one thing that is not wrong.
    expect(res.message).toMatch(/32 bytes/);
    expect(res.message).not.toMatch(/is not set/);
    expect(await listWebhooks(db, p.accountId)).toHaveLength(0);
  });

  it('creates the webhook, and returns the secret once, when the key is usable', async () => {
    const admin = makeAdmin({ INTEGRATION_ENCRYPTION_KEY: KEY_B64 }, db);
    const created = await admin.createWebhook(p, body);

    expect(created.secret).toMatch(/^whsec_/);
    // Stored as an envelope, and the list projection carries neither column.
    const row = await db.get<{ secret: string | null; secret_cipher: string | null }>(
      sql`SELECT secret, secret_cipher FROM webhook WHERE id = ${created.id}`,
    );
    expect(row!.secret).toBeNull();
    expect(row!.secret_cipher).toMatch(/^v1\./);
    expect(JSON.stringify(await listWebhooks(db, p.accountId))).not.toContain(created.secret);
  });
});
