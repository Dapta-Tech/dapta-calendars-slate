import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import { loadEncryptionKey } from './crypto';
import { jsonParam } from './repository';
import { createWebhook, deliverWebhookEvent } from './parity';

/**
 * W (#75) against a REAL Postgres. Its SQLite twin
 * (`webhook-secret-envelope.spec.ts`) owns the RULES; this file exists for the
 * one thing SQLite cannot prove:
 *
 *  - `secret_cipher` is a column added by a SEPARATE Postgres migration, and the
 *    legacy fallback depends on a real `NULL` in `secret_cipher` behaving as
 *    "not encrypted" against Postgres' typed NULL rather than SQLite's untyped
 *    one. A dialect break here is a production deployment that stops signing
 *    deliveries while CI on SQLite stays green.
 *
 * EVERY fixture is created by this file and unique per run — a Postgres
 * `DATABASE_URL` is a persistent, SHARED database that other pg specs seed.
 * Nothing here touches the demo `acme` account. Skipped on the SQLite default.
 */
const url = process.env.DATABASE_URL ?? '';
const isPg = url.startsWith('postgres://') || url.startsWith('postgresql://');
const describePg = isPg ? describe : describe.skip;

const KEY = loadEncryptionKey(randomBytes(32).toString('base64'));
const SUBSCRIBER = 'https://198.51.100.10/hook';
const BODY = JSON.stringify({ event: 'booking.created', data: { uid: 'x' } });

const sign = (secret: string, body: string): string =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

function recorder() {
  const calls: Array<{ headers: Record<string, string>; body: string }> = [];
  const impl = (async (_url: string, init: { headers: Record<string, string>; body: string }) => {
    calls.push({ headers: init.headers, body: init.body });
    return { ok: true, status: 200 } as Response;
  }) as unknown as typeof fetch;
  return { calls, impl };
}

describePg('webhook signing secrets at rest (W, #75 — real Postgres)', () => {
  let db: Db;

  beforeAll(async () => {
    db = await createDb(url);
    await migrate(db);
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  async function freshAccount(): Promise<string> {
    const id = randomUUID();
    await db.run(
      sql`INSERT INTO account (id, code, name, created_at)
          VALUES (${id}, ${'wh' + id.slice(0, 6)}, ${'Webhook Co'}, ${Date.now()})`,
    );
    return id;
  }

  const rawSecretColumns = (id: string) =>
    db.get<{ secret: string | null; secret_cipher: string | null }>(
      sql`SELECT secret, secret_cipher FROM webhook WHERE id = ${id}`,
    );

  it('stores an envelope, not the secret, and signs the delivery from it', async () => {
    const accountId = await freshAccount();
    const wh = await createWebhook(db, {
      accountId,
      subscriberUrl: SUBSCRIBER,
      eventTriggers: ['booking.created'],
      key: KEY,
    });

    const row = await rawSecretColumns(wh.id);
    expect(row!.secret).toBeNull();
    expect(row!.secret_cipher).toMatch(/^v1\./);
    expect(row!.secret_cipher).not.toContain(wh.secret);

    const { calls, impl } = recorder();
    await deliverWebhookEvent(db, { webhookId: wh.id, body: BODY, key: KEY }, impl);
    expect(calls[0]!.headers['X-Slate-Signature']).toBe(sign(wh.secret, BODY));
  });

  it('a pre-migration plaintext row still signs, then is re-sealed in place', async () => {
    const accountId = await freshAccount();
    // The row a deployment carries across the migration: plaintext secret, and a
    // genuinely NULL secret_cipher in a typed Postgres column.
    const id = randomUUID();
    await db.run(
      sql`INSERT INTO webhook (id, account_id, subscriber_url, secret, event_triggers, active, created_at)
          VALUES (${id}, ${accountId}, ${SUBSCRIBER}, ${'legacy-s3cret'},
            ${jsonParam(db, ['booking.created'])}, 1, ${Date.now()})`,
    );

    const before = recorder();
    await deliverWebhookEvent(db, { webhookId: id, body: BODY, key: KEY }, before.impl);
    expect(before.calls[0]!.headers['X-Slate-Signature']).toBe(sign('legacy-s3cret', BODY));

    const row = await rawSecretColumns(id);
    expect(row!.secret).toBeNull();
    expect(row!.secret_cipher).toMatch(/^v1\./);

    // The subscriber sees the same signature before and after the re-seal.
    const after = recorder();
    await deliverWebhookEvent(db, { webhookId: id, body: BODY, key: KEY }, after.impl);
    expect(after.calls[0]!.headers['X-Slate-Signature']).toBe(
      before.calls[0]!.headers['X-Slate-Signature'],
    );
  });

  it('refuses to deliver an envelope it has no key for', async () => {
    const accountId = await freshAccount();
    const wh = await createWebhook(db, {
      accountId,
      subscriberUrl: SUBSCRIBER,
      eventTriggers: ['booking.created'],
      key: KEY,
    });
    const { calls, impl } = recorder();
    await expect(
      deliverWebhookEvent(db, { webhookId: wh.id, body: BODY, key: null }, impl),
    ).rejects.toThrow(/INTEGRATION_ENCRYPTION_KEY/);
    expect(calls).toHaveLength(0);
  });
});
