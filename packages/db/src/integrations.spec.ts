import { describe, it, expect, beforeEach } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createDb, type Db } from './client';
import { migrate } from './migrate';
import { loadEncryptionKey } from './crypto';
import {
  crmDestination,
  disconnectAccountIntegration,
  getAccountIntegration,
  listAccountIntegrations,
  recordIntegrationHealth,
  resolveProviderToken,
  upsertAccountIntegration,
} from './integrations';
import { enqueueOutbox } from './outbox';

/**
 * Seam B — the `account_integration` data layer (H1a / #63).
 *
 * The rules under test are the ones a duplicate meeting or a leaked credential
 * would come from: the row id survives a disconnect, the cipher never appears in
 * a status projection, and a connected credential beats the env fallback while a
 * deliberately disconnected one beats it too — with nothing.
 */
const KEY = loadEncryptionKey(randomBytes(32).toString('base64'));
const TOKEN = 'pat-live-aaaa-bbbb-cccc-9911';

describe('account_integration (H1a, #92)', () => {
  let db: Db;
  let accountId: string;
  let otherAccountId: string;

  async function makeAccount(): Promise<string> {
    const id = randomUUID();
    await db.run(
      sql`INSERT INTO account (id, code, name, created_at)
          VALUES (${id}, ${'i' + id.slice(0, 6)}, ${'Integration Co'}, ${Date.now()})`,
    );
    return id;
  }

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    accountId = await makeAccount();
    otherAccountId = await makeAccount();
  });

  // --- Storage + the shape a client may see --------------------------------

  it('stores a credential and reports only a label and last4', async () => {
    const row = await upsertAccountIntegration(db, {
      accountId,
      provider: 'hubspot',
      token: TOKEN,
      key: KEY,
      label: 'Acme portal',
    });
    expect(row.status).toBe('connected');
    expect(row.label).toBe('Acme portal');
    expect(row.tokenLast4).toBe('9911');
    // The property that matters: nothing serializable carries the credential.
    expect(JSON.stringify(row)).not.toContain(TOKEN);
    expect(Object.keys(row)).not.toContain('tokenCipher');
  });

  it('never stores the token in plaintext', async () => {
    await upsertAccountIntegration(db, { accountId, provider: 'hubspot', token: TOKEN, key: KEY });
    const raw = await db.get<{ token_cipher: string }>(
      sql`SELECT token_cipher FROM account_integration WHERE account_id = ${accountId}`,
    );
    expect(raw?.token_cipher).toBeTruthy();
    expect(raw!.token_cipher).not.toContain(TOKEN);
    expect(raw!.token_cipher.startsWith('v1.')).toBe(true);
  });

  it('keeps one row per (account, provider) — a re-connect UPDATES', async () => {
    const first = await upsertAccountIntegration(db, {
      accountId,
      provider: 'hubspot',
      token: TOKEN,
      key: KEY,
    });
    const second = await upsertAccountIntegration(db, {
      accountId,
      provider: 'hubspot',
      token: 'pat-live-dddd-eeee-ffff-4242',
      key: KEY,
    });
    expect(second.id).toBe(first.id);
    expect(second.tokenLast4).toBe('4242');
    expect(await listAccountIntegrations(db, accountId)).toHaveLength(1);
  });

  it('scopes to the account — one workspace cannot see another\'s', async () => {
    await upsertAccountIntegration(db, { accountId, provider: 'hubspot', token: TOKEN, key: KEY });
    expect(await listAccountIntegrations(db, otherAccountId)).toEqual([]);
    expect(await getAccountIntegration(db, otherAccountId, 'hubspot')).toBeNull();
  });

  // --- Disconnect: the id must survive -------------------------------------

  it('scrubs the credential on disconnect but KEEPS the row id', async () => {
    const before = await upsertAccountIntegration(db, {
      accountId,
      provider: 'hubspot',
      token: TOKEN,
      key: KEY,
    });
    expect(await disconnectAccountIntegration(db, accountId, 'hubspot')).toBe(true);

    const after = await getAccountIntegration(db, accountId, 'hubspot');
    expect(after?.status).toBe('disconnected');
    expect(after?.id).toBe(before.id);
    const raw = await db.get<{ token_cipher: string | null }>(
      sql`SELECT token_cipher FROM account_integration WHERE id = ${before.id}`,
    );
    expect(raw?.token_cipher).toBeNull();
  });

  /**
   * The reason the soft delete exists. `booking_reference.destination` names
   * this id; if reconnecting minted a new one, every stored reference would
   * stop matching and the first cancellation after a reconnect would create a
   * SECOND meeting instead of updating the first (#63).
   */
  it('reconnecting the same portal reuses the same id, so references still match', async () => {
    const first = await upsertAccountIntegration(db, {
      accountId,
      provider: 'hubspot',
      token: TOKEN,
      key: KEY,
    });
    const destination = crmDestination(first.id);
    await disconnectAccountIntegration(db, accountId, 'hubspot');
    const reconnected = await upsertAccountIntegration(db, {
      accountId,
      provider: 'hubspot',
      token: TOKEN,
      key: KEY,
    });
    expect(reconnected.id).toBe(first.id);
    expect(crmDestination(reconnected.id)).toBe(destination);
    expect(reconnected.status).toBe('connected');
  });

  // A reversed decision, not a delivery failure.
  it('marks pending crm outbox rows skipped on disconnect, not failed', async () => {
    await upsertAccountIntegration(db, { accountId, provider: 'hubspot', token: TOKEN, key: KEY });
    const mine = await enqueueOutbox(db, {
      kind: 'crm',
      action: 'booking_write_out',
      bookingUid: 'uid-1',
      accountId,
    });
    const theirs = await enqueueOutbox(db, {
      kind: 'crm',
      action: 'booking_write_out',
      bookingUid: 'uid-2',
      accountId: otherAccountId,
    });
    const calendar = await enqueueOutbox(db, {
      kind: 'calendar',
      action: 'create',
      bookingUid: 'uid-3',
      accountId,
    });

    await disconnectAccountIntegration(db, accountId, 'hubspot');

    const statusOf = async (id: string) =>
      (await db.get<{ status: string }>(sql`SELECT status FROM outbox WHERE id = ${id}`))?.status;
    expect(await statusOf(mine)).toBe('skipped');
    // Another account's queue is untouched, and so is another kind's.
    expect(await statusOf(theirs)).toBe('pending');
    expect(await statusOf(calendar)).toBe('pending');
  });

  it('reports false when there is nothing to disconnect', async () => {
    expect(await disconnectAccountIntegration(db, accountId, 'hubspot')).toBe(false);
  });

  // --- Health, and the structured error ------------------------------------

  /**
   * #74 found the 403 carries a scope NAME LIST, not prose. Storing it as data
   * is what lets H1b name the exact checkbox the host missed.
   */
  it('stores the structured provider error, parsed back as an object', async () => {
    const row = await upsertAccountIntegration(db, {
      accountId,
      provider: 'hubspot',
      token: TOKEN,
      key: KEY,
    });
    await recordIntegrationHealth(db, {
      integrationId: row.id,
      ok: false,
      detail: 'rejected',
      errorDetail: {
        category: 'MISSING_SCOPES',
        requiredGranularScopes: ['crm.objects.contacts.write'],
      },
    });
    const after = await getAccountIntegration(db, accountId, 'hubspot');
    expect(after?.status).toBe('unhealthy');
    expect(after?.lastCheckOk).toBe(false);
    expect(after?.lastErrorDetail).toEqual({
      category: 'MISSING_SCOPES',
      requiredGranularScopes: ['crm.objects.contacts.write'],
    });
  });

  // Never auto-disable (#63): fixing the scope in the portal must be enough.
  it('an unhealthy integration keeps its credential and can recover', async () => {
    const row = await upsertAccountIntegration(db, {
      accountId,
      provider: 'hubspot',
      token: TOKEN,
      key: KEY,
    });
    await recordIntegrationHealth(db, { integrationId: row.id, ok: false, detail: 'boom' });
    expect((await resolveProviderToken(db, accountId, 'hubspot', KEY))?.token).toBe(TOKEN);

    await recordIntegrationHealth(db, { integrationId: row.id, ok: true });
    const after = await getAccountIntegration(db, accountId, 'hubspot');
    expect(after?.status).toBe('connected');
    expect(after?.lastErrorDetail).toBeNull();
  });

  it('clears a stale error when the credential is re-connected', async () => {
    const row = await upsertAccountIntegration(db, {
      accountId,
      provider: 'hubspot',
      token: TOKEN,
      key: KEY,
    });
    await recordIntegrationHealth(db, {
      integrationId: row.id,
      ok: false,
      errorDetail: { category: 'MISSING_SCOPES', requiredGranularScopes: ['a'] },
    });
    const again = await upsertAccountIntegration(db, {
      accountId,
      provider: 'hubspot',
      token: TOKEN,
      key: KEY,
    });
    expect(again.status).toBe('connected');
    expect(again.lastErrorDetail).toBeNull();
  });

  // --- Resolution order ----------------------------------------------------

  it('a connected credential beats the env fallback', async () => {
    const row = await upsertAccountIntegration(db, {
      accountId,
      provider: 'hubspot',
      token: TOKEN,
      key: KEY,
    });
    const resolved = await resolveProviderToken(db, accountId, 'hubspot', KEY, 'env-token-value');
    expect(resolved).toEqual({ token: TOKEN, integrationId: row.id });
  });

  it('falls back to the deployment token when no account has connected one', async () => {
    const resolved = await resolveProviderToken(db, accountId, 'hubspot', KEY, 'env-token-value');
    expect(resolved).toEqual({ token: 'env-token-value', integrationId: null });
    expect(crmDestination(null)).toBe('crm:env');
  });

  // "Disconnect" is an instruction, and the fallback must not quietly undo it.
  it('a DISCONNECTED account resolves to nothing, even with an env fallback set', async () => {
    await upsertAccountIntegration(db, { accountId, provider: 'hubspot', token: TOKEN, key: KEY });
    await disconnectAccountIntegration(db, accountId, 'hubspot');
    expect(await resolveProviderToken(db, accountId, 'hubspot', KEY, 'env-token-value')).toBeNull();
  });

  it('treats a placeholder env value as unset', async () => {
    expect(
      await resolveProviderToken(db, accountId, 'hubspot', KEY, 'replace-with-your-private-app-token'),
    ).toBeNull();
    expect(await resolveProviderToken(db, accountId, 'hubspot', KEY)).toBeNull();
  });

  // Loud, not silent: falling through to the env fallback here would write this
  // account's bookings into whatever portal the operator configured.
  it('throws rather than falling back when a stored credential cannot be opened', async () => {
    await upsertAccountIntegration(db, { accountId, provider: 'hubspot', token: TOKEN, key: KEY });
    await expect(
      resolveProviderToken(db, accountId, 'hubspot', null, 'env-token-value'),
    ).rejects.toThrow(/INTEGRATION_ENCRYPTION_KEY/);
  });

  it('cannot open one account\'s credential from another account\'s row', async () => {
    await upsertAccountIntegration(db, { accountId, provider: 'hubspot', token: TOKEN, key: KEY });
    const cipher = await db.get<{ token_cipher: string }>(
      sql`SELECT token_cipher FROM account_integration WHERE account_id = ${accountId}`,
    );
    // Plant account A's ciphertext on account B, the way a compromised write or
    // a bad restore might.
    await db.run(
      sql`INSERT INTO account_integration
            (id, account_id, provider, status, token_cipher, created_at, updated_at)
          VALUES (${randomUUID()}, ${otherAccountId}, 'hubspot', 'connected',
            ${cipher!.token_cipher}, ${Date.now()}, ${Date.now()})`,
    );
    await expect(resolveProviderToken(db, otherAccountId, 'hubspot', KEY)).rejects.toThrow();
  });
});
