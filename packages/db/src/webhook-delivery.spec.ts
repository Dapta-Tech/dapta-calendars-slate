import { describe, it, expect, beforeEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import { seed } from './seed';
import { loadEncryptionKey } from './crypto';
import { deliverWebhookEvent, listWebhookDeliveries, createWebhook } from './parity';

/** W (#75): the secret rides the envelope now, so every path needs the key. */
const KEY = loadEncryptionKey(randomBytes(32).toString('base64'));

/**
 * QA fix 10 — webhook delivery history. Every REAL delivery attempt (success,
 * HTTP failure, egress-blocked, thrown fetch) leaves a queryable row so the
 * dashboard can prove hooks are landing; before this only the manual test
 * ping gave any signal. Listing is account-scoped.
 */
describe('webhook delivery history (QA fix 10)', () => {
  let db: Db;
  let accountId: string;
  let webhookId: string;

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code='acme'`))!.id;
    const hook = await createWebhook(db, {
      accountId,
      subscriberUrl: 'https://example.com/hook',
      eventTriggers: ['booking.created'],
      secret: 's3cret',
      key: KEY,
    });
    webhookId = hook.id;
  });

  const body = JSON.stringify({ event: 'booking.created', data: { uid: 'x' } });
  const okFetch = (async () => new Response('ok', { status: 200 })) as typeof fetch;
  const failFetch = (async () => new Response('nope', { status: 500 })) as typeof fetch;
  const throwFetch = (async () => {
    throw new Error('ECONNREFUSED');
  }) as typeof fetch;

  it('records a successful delivery with its HTTP status', async () => {
    await deliverWebhookEvent(db, { webhookId, body, key: KEY }, okFetch);
    const items = await listWebhookDeliveries(db, accountId, webhookId);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ event: 'booking.created', ok: true, statusCode: 200 });
  });

  it('records HTTP failures and thrown fetches (and still throws for the outbox retry)', async () => {
    await expect(deliverWebhookEvent(db, { webhookId, body, key: KEY }, failFetch)).rejects.toThrow();
    await expect(deliverWebhookEvent(db, { webhookId, body, key: KEY }, throwFetch)).rejects.toThrow();
    const items = await listWebhookDeliveries(db, accountId, webhookId);
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.ok)).toEqual([false, false]);
    expect(items[1]!.statusCode).toBe(500);
    expect(items[0]!.error).toContain('ECONNREFUSED');
  });

  it('listing is account-scoped (another account sees nothing)', async () => {
    await deliverWebhookEvent(db, { webhookId, body, key: KEY }, okFetch);
    const other = await listWebhookDeliveries(db, 'not-my-account', webhookId);
    expect(other).toHaveLength(0);
  });

  it('retention: keeps only the newest 50 per webhook', async () => {
    for (let i = 0; i < 55; i++) await deliverWebhookEvent(db, { webhookId, body, key: KEY }, okFetch);
    const rows = await db.get<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM webhook_delivery WHERE webhook_id = ${webhookId}`,
    );
    expect(Number(rows!.n)).toBe(50);
  });
});
