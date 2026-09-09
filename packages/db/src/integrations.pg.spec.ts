import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import { loadEncryptionKey } from './crypto';
import {
  crmDestination,
  disconnectAccountIntegration,
  getAccountIntegration,
  recordIntegrationHealth,
  resolveProviderToken,
  upsertAccountIntegration,
} from './integrations';
import { claimBookingDestination, loadBookingReferences } from './calendar-refs';
import { enqueueOutbox } from './outbox';

/**
 * The `account_integration` layer against a REAL Postgres. Its SQLite twin
 * (`integrations.spec.ts`) owns the RULES; this file exists for the places the
 * dialects genuinely differ and where SQLite would hide a break:
 *
 *  - `last_error_detail` is `jsonb` here and TEXT JSON there. The write goes
 *    through `jsonParam`'s `::jsonb` cast and the read comes back ALREADY
 *    PARSED rather than as a string. That column is what H1b renders the missing
 *    scope list from, so a dialect difference in it is a UI bug in production
 *    that CI on SQLite would pass.
 *  - The `(account_id, provider)` unique index is what makes reconnect an UPDATE
 *    of the same row, and the row id is what `booking_reference.destination`
 *    points at. If that broke on Postgres only, the first cancellation after a
 *    reconnect would create a SECOND meeting in a customer's CRM.
 *
 * EVERY fixture here is created by this file and unique per run — a Postgres
 * `DATABASE_URL` is a persistent, SHARED database and other pg specs seed it.
 * Nothing here reads or writes the demo `acme` account, so there is no seed to
 * guard. Skipped on the SQLite dev default, like its neighbours.
 */
const url = process.env.DATABASE_URL ?? '';
const isPg = url.startsWith('postgres://') || url.startsWith('postgresql://');
const describePg = isPg ? describe : describe.skip;

const KEY = loadEncryptionKey(randomBytes(32).toString('base64'));
const TOKEN = 'pat-live-pg-0000-1111-7788';

describePg('account_integration (real Postgres)', () => {
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
          VALUES (${id}, ${'ai' + id.slice(0, 6)}, ${'Integration Co'}, ${Date.now()})`,
    );
    return id;
  }

  /** The jsonb half of the guarantee. Its SQLite twin covers TEXT JSON. */
  it('round-trips the structured provider error through jsonb, parsed rather than stringified', async () => {
    const accountId = await freshAccount();
    const row = await upsertAccountIntegration(db, {
      accountId,
      provider: 'hubspot',
      token: TOKEN,
      key: KEY,
    });
    const detail = {
      category: 'MISSING_SCOPES',
      requiredGranularScopes: ['crm.objects.contacts.read', 'crm.objects.contacts.write'],
    };
    await recordIntegrationHealth(db, {
      integrationId: row.id,
      ok: false,
      detail: 'rejected',
      errorDetail: detail,
    });

    const after = await getAccountIntegration(db, accountId, 'hubspot');
    expect(after?.status).toBe('unhealthy');
    expect(after?.lastErrorDetail).toEqual(detail);
    expect(typeof after?.lastErrorDetail).toBe('object');
    expect(after?.lastErrorDetail?.requiredGranularScopes).toHaveLength(2);
  });

  it('clears the structured error to a real NULL, not the string "null"', async () => {
    const accountId = await freshAccount();
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
    await recordIntegrationHealth(db, { integrationId: row.id, ok: true, errorDetail: null });
    expect((await getAccountIntegration(db, accountId, 'hubspot'))?.lastErrorDetail).toBeNull();
  });

  /**
   * The duplicate-meeting guarantee, end to end on the dialect that ships:
   * disconnect, reconnect, and the destination a stored reference names still
   * resolves to the same row.
   */
  it('keeps the row id across a disconnect/reconnect, so a stored reference still matches', async () => {
    const accountId = await freshAccount();
    const first = await upsertAccountIntegration(db, {
      accountId,
      provider: 'hubspot',
      token: TOKEN,
      key: KEY,
    });

    // A booking already written out under this integration.
    const bookingId = randomUUID();
    await db.run(
      sql`INSERT INTO booking
            (id, account_id, uid, title, start_ms, end_ms, status, created_at, updated_at)
          VALUES (${bookingId}, ${accountId}, ${'u' + bookingId.slice(0, 8)}, 'Intro call',
            ${Date.now()}, ${Date.now() + 1800_000}, 'accepted', ${Date.now()}, ${Date.now()})`,
    );
    const claimId = await claimBookingDestination(db, bookingId, crmDestination(first.id), 'crm');
    expect(claimId).toBeTruthy();

    await disconnectAccountIntegration(db, accountId, 'hubspot');
    const again = await upsertAccountIntegration(db, {
      accountId,
      provider: 'hubspot',
      token: TOKEN,
      key: KEY,
    });
    expect(again.id).toBe(first.id);

    // The claim is still held for the reconnected integration's destination, so
    // a re-run cannot create a second meeting.
    const refs = await loadBookingReferences(db, bookingId);
    expect(refs.map((r) => r.destination)).toContain(crmDestination(again.id));
    expect(await claimBookingDestination(db, bookingId, crmDestination(again.id), 'crm')).toBeNull();
  });

  it('enforces one credential per (account, provider) at the index level', async () => {
    const accountId = await freshAccount();
    await upsertAccountIntegration(db, { accountId, provider: 'hubspot', token: TOKEN, key: KEY });
    // A second INSERT bypassing the upsert must be refused by the DB itself —
    // the app-level upsert is the convenience, the index is the guarantee.
    await expect(
      db.run(
        sql`INSERT INTO account_integration (id, account_id, provider, status, created_at, updated_at)
            VALUES (${randomUUID()}, ${accountId}, 'hubspot', 'connected', ${Date.now()}, ${Date.now()})`,
      ),
    ).rejects.toThrow();
  });

  it('decrypts a credential stored on Postgres, and refuses it under another account', async () => {
    const accountId = await freshAccount();
    const otherId = await freshAccount();
    await upsertAccountIntegration(db, { accountId, provider: 'hubspot', token: TOKEN, key: KEY });

    expect((await resolveProviderToken(db, accountId, 'hubspot', KEY))?.token).toBe(TOKEN);

    const cipher = await db.get<{ token_cipher: string }>(
      sql`SELECT token_cipher FROM account_integration WHERE account_id = ${accountId}`,
    );
    await db.run(
      sql`INSERT INTO account_integration
            (id, account_id, provider, status, token_cipher, created_at, updated_at)
          VALUES (${randomUUID()}, ${otherId}, 'hubspot', 'connected', ${cipher!.token_cipher},
            ${Date.now()}, ${Date.now()})`,
    );
    await expect(resolveProviderToken(db, otherId, 'hubspot', KEY)).rejects.toThrow();
  });

  it('skips only this account\'s pending crm rows on disconnect', async () => {
    const accountId = await freshAccount();
    const otherId = await freshAccount();
    await upsertAccountIntegration(db, { accountId, provider: 'hubspot', token: TOKEN, key: KEY });
    const mine = await enqueueOutbox(db, {
      kind: 'crm',
      action: 'booking_write_out',
      bookingUid: randomUUID(),
      accountId,
    });
    const theirs = await enqueueOutbox(db, {
      kind: 'crm',
      action: 'booking_write_out',
      bookingUid: randomUUID(),
      accountId: otherId,
    });

    await disconnectAccountIntegration(db, accountId, 'hubspot');

    const statusOf = async (id: string) =>
      (await db.get<{ status: string }>(sql`SELECT status FROM outbox WHERE id = ${id}`))?.status;
    expect(await statusOf(mine)).toBe('skipped');
    expect(await statusOf(theirs)).toBe('pending');
  });
});
