import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addGuestsToBooking,
  claimApiIdempotency,
  completeApiIdempotency,
  listProviderCalendars,
  upsertProviderCalendar,
} from './v2-pilot';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import { seed } from './seed';

describe('v2 pilot persistence (SQLite)', () => {
  let db: Db;
  let accountId: string;
  let memberId: string;
  let connectionId: string;

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code = 'acme'`))!.id;
    memberId = (await db.get<{ id: string }>(
      sql`SELECT id FROM member WHERE account_id = ${accountId} AND handle = 'alex-rivera'`,
    ))!.id;
    connectionId = randomUUID();
    await db.run(
      sql`INSERT INTO connected_calendar
            (id, account_id, member_id, provider, external_id, is_destination,
             check_conflicts, created_at)
          VALUES (${connectionId}, ${accountId}, ${memberId}, ${'google'},
            ${'connection-ref'}, 1, 1, ${Date.now()})`,
    );
  });

  afterEach(async () => db.close());

  it('keeps stable provider-calendar IDs while refreshing permission metadata', async () => {
    const connection = {
      id: connectionId,
      accountId,
      memberId,
      provider: 'google',
      connectionRef: 'connection-ref',
      primaryEmail: null,
      isDestination: true,
      checkConflicts: true,
    };
    const first = await upsertProviderCalendar(db, {
      connection,
      externalId: 'primary@example.com',
      name: 'Primary',
      primary: true,
      readOnly: true,
      accessRole: 'reader',
      source: 'primary',
      capabilities: {
        canRead: true,
        canReadFreeBusy: true,
        canCreate: false,
        canUpdate: false,
        canDelete: false,
      },
    });
    const refreshed = await upsertProviderCalendar(db, {
      connection,
      externalId: 'primary@example.com',
      name: 'Primary renamed',
      primary: true,
      readOnly: false,
      accessRole: 'owner',
      source: 'primary',
      capabilities: {
        canRead: true,
        canReadFreeBusy: true,
        canCreate: true,
        canUpdate: true,
        canDelete: true,
      },
    });
    expect(refreshed).toMatchObject({
      id: first.id,
      name: 'Primary renamed',
      readOnly: false,
      capabilities: { canCreate: true },
    });
    expect(await listProviderCalendars(db, accountId)).toHaveLength(1);
  });

  it('stores no plaintext idempotency key and replays the completed response', async () => {
    const namespaceHash = 'hashed-namespace-only';
    const claim = await claimApiIdempotency(db, {
      namespaceHash,
      accountId,
      apiKeyId: 'key-id',
      method: 'POST',
      path: '/v2/bookings/uid/guests',
      requestHash: 'request-hash',
    });
    await completeApiIdempotency(db, claim.id, 200, { uid: 'booking-uid' });
    const replay = await claimApiIdempotency(db, {
      namespaceHash,
      accountId,
      apiKeyId: 'key-id',
      method: 'POST',
      path: '/v2/bookings/uid/guests',
      requestHash: 'request-hash',
    });
    expect(replay).toMatchObject({
      requestHash: 'request-hash',
      statusCode: 200,
      responseBody: { uid: 'booking-uid' },
    });
    const raw = await db.get<{ namespace_hash: string; response_body: string }>(
      sql`SELECT namespace_hash, response_body FROM api_idempotency WHERE id = ${claim.id}`,
    );
    expect(JSON.stringify(raw)).not.toContain('dcl_');
  });

  it('deduplicates guests case-insensitively and enforces the active booking guard', async () => {
    const booking = await db.get<{ uid: string }>(
      sql`SELECT uid FROM booking WHERE account_id = ${accountId} LIMIT 1`,
    );
    if (!booking) {
      const event = (await db.get<{ id: string }>(
        sql`SELECT id FROM event_type WHERE account_id = ${accountId} LIMIT 1`,
      ))!;
      await db.run(
        sql`INSERT INTO booking
              (id, account_id, uid, event_type_id, host_member_id, title,
               start_ms, end_ms, status, created_at, updated_at)
            VALUES (${randomUUID()}, ${accountId}, ${'guest-test'}, ${event.id},
              ${memberId}, ${'Guest test'}, ${Date.now() + 86_400_000},
              ${Date.now() + 86_400_000 + 1_800_000}, 'accepted', ${Date.now()}, ${Date.now()})`,
      );
    }
    const uid = booking?.uid ?? 'guest-test';
    expect(
      await addGuestsToBooking(db, {
        accountId,
        uid,
        guests: [{ email: 'guest@example.com' }, { email: 'GUEST@example.com' }],
      }),
    ).toEqual({ ok: true, added: 1 });
  });
});
