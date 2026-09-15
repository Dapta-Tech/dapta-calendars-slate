import { describe, it, expect, beforeEach } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import { seed } from './seed';
import { encryptSecret, loadEncryptionKey, secretAad, webhookSecretAad } from './crypto';
import {
  createWebhook,
  deliverWebhookEvent,
  dispatchWebhooks,
  listWebhookDeliveries,
  listWebhooks,
  pingWebhook,
} from './parity';

/**
 * W (#75) — webhook signing secrets encrypted at rest.
 *
 * These specs pin the three things the change is actually for: the secret is an
 * envelope in the row and never a readable string; a deployment that predates
 * the envelope keeps signing byte-identically; and a ciphertext that is not the
 * one this row was sealed with fails rather than signing with something else.
 */
const KEY = loadEncryptionKey(randomBytes(32).toString('base64'));
const OTHER_KEY = loadEncryptionKey(randomBytes(32).toString('base64'));

/** A public IP literal: the SSRF guard passes with no DNS, so this stays offline. */
const SUBSCRIBER = 'https://198.51.100.10/hook';
const BODY = JSON.stringify({ event: 'booking.created', data: { uid: 'x' } });

const sign = (secret: string, body: string): string =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

/** A fetch that records what it was handed and always succeeds. */
function recorder() {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  const impl = (async (url: string, init: { headers: Record<string, string>; body: string }) => {
    calls.push({ url, headers: init.headers, body: init.body });
    return { ok: true, status: 200 } as Response;
  }) as unknown as typeof fetch;
  return { calls, impl };
}

/** The two secret columns straight off the row — what a DB reader would see. */
const rawSecretColumns = (db: Db, id: string) =>
  db.get<{ secret: string | null; secret_cipher: string | null }>(
    sql`SELECT secret, secret_cipher FROM webhook WHERE id = ${id}`,
  );

/**
 * Insert a webhook the way the code did BEFORE this change: plaintext `secret`,
 * no `secret_cipher`. This is the migrated-deployment row every legacy case
 * below is about, and it is written with raw SQL precisely because the current
 * `createWebhook` can no longer produce one.
 */
async function insertLegacyWebhook(
  db: Db,
  args: { accountId: string; secret: string; triggers?: string[] },
): Promise<string> {
  const id = `legacy-${randomBytes(8).toString('hex')}`;
  const triggers = JSON.stringify(args.triggers ?? ['booking.created']);
  await db.run(
    sql`INSERT INTO webhook (id, account_id, subscriber_url, secret, event_triggers, active, created_at)
        VALUES (${id}, ${args.accountId}, ${SUBSCRIBER}, ${args.secret}, ${triggers}, 1, ${Date.now()})`,
  );
  return id;
}

describe('webhook signing secrets at rest (W, #75)', () => {
  let db: Db;
  let accountId: string;

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code='acme'`))!.id;
  });

  it('round-trips: the row holds an envelope, and the delivery signs with the plaintext', async () => {
    const wh = await createWebhook(db, {
      accountId,
      subscriberUrl: SUBSCRIBER,
      eventTriggers: ['booking.created'],
      key: KEY,
    });

    // Generation is unchanged by this unit — same prefix a subscriber knows.
    expect(wh.secret).toMatch(/^whsec_/);

    const row = await rawSecretColumns(db, wh.id);
    expect(row!.secret).toBeNull(); // one authoritative column, never both
    expect(row!.secret_cipher).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(row!.secret_cipher).not.toContain(wh.secret); // the secret is not in the row

    const { calls, impl } = recorder();
    await deliverWebhookEvent(db, { webhookId: wh.id, body: BODY, key: KEY }, impl);
    expect(calls[0]!.headers['X-Slate-Signature']).toBe(sign(wh.secret, BODY));
  });

  it('never returns the secret from a read endpoint', async () => {
    const wh = await createWebhook(db, {
      accountId,
      subscriberUrl: SUBSCRIBER,
      eventTriggers: ['booking.created'],
      key: KEY,
    });
    const listed = await listWebhooks(db, accountId);
    const serialized = JSON.stringify(listed);
    expect(serialized).not.toContain(wh.secret);
    expect(serialized).not.toContain('secret');

    // The delivery log is the other read surface a dashboard renders.
    const { impl } = recorder();
    await deliverWebhookEvent(db, { webhookId: wh.id, body: BODY, key: KEY }, impl);
    expect(JSON.stringify(await listWebhookDeliveries(db, accountId, wh.id))).not.toContain(
      wh.secret,
    );
  });

  it('a legacy plaintext row still signs — with a key configured and with none', async () => {
    const withKey = await insertLegacyWebhook(db, { accountId, secret: 'legacy-s3cret' });
    const withoutKey = await insertLegacyWebhook(db, { accountId, secret: 'legacy-s3cret' });

    const a = recorder();
    await deliverWebhookEvent(db, { webhookId: withKey, body: BODY, key: KEY }, a.impl);
    expect(a.calls[0]!.headers['X-Slate-Signature']).toBe(sign('legacy-s3cret', BODY));

    // The whole point of the key-absent contract: a deployment that never had a
    // key keeps delivering exactly as it does today.
    const b = recorder();
    await deliverWebhookEvent(db, { webhookId: withoutKey, body: BODY, key: null }, b.impl);
    expect(b.calls[0]!.headers['X-Slate-Signature']).toBe(sign('legacy-s3cret', BODY));
  });

  it('a legacy plaintext row is left alone when there is no key to re-seal it with', async () => {
    const id = await insertLegacyWebhook(db, { accountId, secret: 'legacy-s3cret' });
    const { impl } = recorder();
    await deliverWebhookEvent(db, { webhookId: id, body: BODY, key: null }, impl);

    const row = await rawSecretColumns(db, id);
    expect(row!.secret).toBe('legacy-s3cret'); // untouched — nothing to upgrade to
    expect(row!.secret_cipher).toBeNull();
  });

  it('lazily re-seals a legacy row once a key is present, without changing the signature', async () => {
    const id = await insertLegacyWebhook(db, { accountId, secret: 'legacy-s3cret' });

    const before = recorder();
    await deliverWebhookEvent(db, { webhookId: id, body: BODY, key: KEY }, before.impl);

    const row = await rawSecretColumns(db, id);
    expect(row!.secret).toBeNull(); // plaintext drained
    expect(row!.secret_cipher).toMatch(/^v1\./);

    // Same secret, same signature — the subscriber sees no difference at all.
    const after = recorder();
    await deliverWebhookEvent(db, { webhookId: id, body: BODY, key: KEY }, after.impl);
    expect(after.calls[0]!.headers['X-Slate-Signature']).toBe(
      before.calls[0]!.headers['X-Slate-Signature'],
    );
    expect(after.calls[0]!.headers['X-Slate-Signature']).toBe(sign('legacy-s3cret', BODY));
  });

  it('two concurrent deliveries on the same legacy row cannot lose the secret', async () => {
    // The re-seal is guarded by `secret_cipher IS NULL`, so of two racing
    // workers exactly one UPDATE matches. The claim worth pinning is that the
    // loser does not clobber the winner and both still sign identically — a
    // divergence here would be a subscriber rejecting a real delivery.
    const id = await insertLegacyWebhook(db, { accountId, secret: 'legacy-s3cret' });
    const a = recorder();
    const b = recorder();

    await Promise.all([
      deliverWebhookEvent(db, { webhookId: id, body: BODY, key: KEY }, a.impl),
      deliverWebhookEvent(db, { webhookId: id, body: BODY, key: KEY }, b.impl),
    ]);

    const expected = sign('legacy-s3cret', BODY);
    expect(a.calls[0]!.headers['X-Slate-Signature']).toBe(expected);
    expect(b.calls[0]!.headers['X-Slate-Signature']).toBe(expected);

    // Exactly one envelope survives, and it still opens to the same secret.
    const row = await rawSecretColumns(db, id);
    expect(row!.secret).toBeNull();
    expect(row!.secret_cipher).toMatch(/^v1\./);
    const after = recorder();
    await deliverWebhookEvent(db, { webhookId: id, body: BODY, key: KEY }, after.impl);
    expect(after.calls[0]!.headers['X-Slate-Signature']).toBe(expected);
  });

  it('a failed re-seal still delivers: the upgrade is best-effort, signing is not', async () => {
    const id = await insertLegacyWebhook(db, { accountId, secret: 'legacy-s3cret' });
    // Make the upgrade UPDATE fail the way a read-only replica or a lock would,
    // leaving every read path intact.
    const realRun = db.run.bind(db);
    let failed = false;
    db.run = (async (q: Parameters<typeof realRun>[0]) => {
      const text = JSON.stringify(q);
      if (text.includes('secret_cipher')) {
        failed = true;
        throw new Error('attempt to write a readonly database');
      }
      return realRun(q);
    }) as typeof db.run;

    try {
      const { calls, impl } = recorder();
      await deliverWebhookEvent(db, { webhookId: id, body: BODY, key: KEY }, impl);
      expect(calls[0]!.headers['X-Slate-Signature']).toBe(sign('legacy-s3cret', BODY));
      expect(failed).toBe(true);
    } finally {
      db.run = realRun;
    }

    // The plaintext survives the failed upgrade — nothing was lost.
    const row = await rawSecretColumns(db, id);
    expect(row!.secret).toBe('legacy-s3cret');
    expect(row!.secret_cipher).toBeNull();
  });

  it('a key-less deployment cannot open an envelope: the delivery fails, it does not go unsigned', async () => {
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
    expect(calls).toHaveLength(0); // nothing was POSTed, signed or otherwise

    // The failure is recorded for the outbox/dashboard, and names no secret.
    const [logged] = await listWebhookDeliveries(db, accountId, wh.id);
    expect(logged!.ok).toBe(false);
    expect(logged!.error).not.toContain(wh.secret);
  });

  it('a tampered envelope fails to decrypt rather than signing with garbage', async () => {
    const wh = await createWebhook(db, {
      accountId,
      subscriberUrl: SUBSCRIBER,
      eventTriggers: ['booking.created'],
      key: KEY,
    });
    const original = (await rawSecretColumns(db, wh.id))!.secret_cipher!;
    // Flip one character of the ciphertext segment — GCM's tag must catch it.
    const parts = original.split('.');
    parts[3] = (parts[3]![0] === 'A' ? 'B' : 'A') + parts[3]!.slice(1);
    await db.run(sql`UPDATE webhook SET secret_cipher = ${parts.join('.')} WHERE id = ${wh.id}`);

    const { calls, impl } = recorder();
    await expect(
      deliverWebhookEvent(db, { webhookId: wh.id, body: BODY, key: KEY }, impl),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('an envelope lifted into another webhook row fails: the AAD binds it to one row', async () => {
    const a = await createWebhook(db, {
      accountId,
      subscriberUrl: SUBSCRIBER,
      eventTriggers: ['booking.created'],
      key: KEY,
    });
    const b = await createWebhook(db, {
      accountId,
      subscriberUrl: SUBSCRIBER,
      eventTriggers: ['booking.created'],
      key: KEY,
    });
    const aCipher = (await rawSecretColumns(db, a.id))!.secret_cipher!;
    await db.run(sql`UPDATE webhook SET secret_cipher = ${aCipher} WHERE id = ${b.id}`);

    const { calls, impl } = recorder();
    await expect(
      deliverWebhookEvent(db, { webhookId: b.id, body: BODY, key: KEY }, impl),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('does not reuse the CRM AAD: a CRM-bound envelope will not open as a webhook secret', async () => {
    const wh = await createWebhook(db, {
      accountId,
      subscriberUrl: SUBSCRIBER,
      eventTriggers: ['booking.created'],
      key: KEY,
    });
    // The two AADs are different strings, and that difference is load-bearing.
    expect(webhookSecretAad(accountId, wh.id)).not.toBe(secretAad(accountId, wh.id));

    const crmShaped = encryptSecret('pat-live-aaaa', KEY, secretAad(accountId, wh.id));
    await db.run(sql`UPDATE webhook SET secret_cipher = ${crmShaped} WHERE id = ${wh.id}`);

    const { calls, impl } = recorder();
    await expect(
      deliverWebhookEvent(db, { webhookId: wh.id, body: BODY, key: KEY }, impl),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('the wrong key fails rather than silently signing with a different secret', async () => {
    const wh = await createWebhook(db, {
      accountId,
      subscriberUrl: SUBSCRIBER,
      eventTriggers: ['booking.created'],
      key: KEY,
    });
    const { calls, impl } = recorder();
    await expect(
      deliverWebhookEvent(db, { webhookId: wh.id, body: BODY, key: OTHER_KEY }, impl),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it('the caller-supplied secret path is enveloped too, and signs as supplied', async () => {
    // A caller-supplied secret that LOOKS like an envelope is the exact case the
    // separate column exists for: it must be stored and signed with verbatim.
    const supplied = 'v1.not-really-an-envelope';
    const wh = await createWebhook(db, {
      accountId,
      subscriberUrl: SUBSCRIBER,
      eventTriggers: ['booking.created'],
      secret: supplied,
      key: KEY,
    });
    expect(wh.secret).toBe(supplied);
    expect((await rawSecretColumns(db, wh.id))!.secret).toBeNull();

    const { calls, impl } = recorder();
    await deliverWebhookEvent(db, { webhookId: wh.id, body: BODY, key: KEY }, impl);
    expect(calls[0]!.headers['X-Slate-Signature']).toBe(sign(supplied, BODY));
  });

  it('dispatchWebhooks and pingWebhook sign from the envelope too', async () => {
    const wh = await createWebhook(db, {
      accountId,
      subscriberUrl: SUBSCRIBER,
      eventTriggers: ['booking.created'],
      key: KEY,
    });

    const d = recorder();
    const sent = await dispatchWebhooks(db, accountId, 'booking.created', { uid: 'x' }, KEY, d.impl);
    expect(sent).toBe(1);
    expect(d.calls[0]!.headers['X-Slate-Signature']).toBe(sign(wh.secret, d.calls[0]!.body));

    const p = recorder();
    const ping = await pingWebhook(db, accountId, wh.id, KEY, p.impl);
    expect(ping.ok).toBe(true);
    expect(p.calls[0]!.headers['X-Slate-Signature']).toBe(sign(wh.secret, p.calls[0]!.body));
  });

  it('a ping that cannot be signed reports the reason instead of throwing', async () => {
    const wh = await createWebhook(db, {
      accountId,
      subscriberUrl: SUBSCRIBER,
      eventTriggers: ['booking.created'],
      key: KEY,
    });
    const { calls, impl } = recorder();
    const res = await pingWebhook(db, accountId, wh.id, null, impl);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/could not be decrypted/i);
    expect(res.message).not.toContain(wh.secret);
    expect(calls).toHaveLength(0);
  });

  it('dispatchWebhooks drops only the subscriber it cannot sign for', async () => {
    const good = await createWebhook(db, {
      accountId,
      subscriberUrl: SUBSCRIBER,
      eventTriggers: ['booking.created'],
      key: KEY,
    });
    const bad = await createWebhook(db, {
      accountId,
      subscriberUrl: SUBSCRIBER,
      eventTriggers: ['booking.created'],
      key: KEY,
    });
    // Seal `bad` under a key this dispatch will not hold.
    await db.run(
      sql`UPDATE webhook SET secret_cipher = ${encryptSecret('x', OTHER_KEY, webhookSecretAad(accountId, bad.id))}
          WHERE id = ${bad.id}`,
    );

    const { calls, impl } = recorder();
    const sent = await dispatchWebhooks(db, accountId, 'booking.created', { uid: 'x' }, KEY, impl);
    expect(sent).toBe(1); // the healthy one still went
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers['X-Slate-Signature']).toBe(sign(good.secret, calls[0]!.body));
  });
});
