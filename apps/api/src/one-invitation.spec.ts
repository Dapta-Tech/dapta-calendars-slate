import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, migrate, seed, sql, type Db } from '@slate/db';
import { attendeeEmailedFor, wantsConferencingLink } from './email-effects';

/**
 * The two decisions behind "one invitation per booking" (F4 of the 2026-10-30
 * production E2E), shared by the calendar write and the email outbox so they
 * can never disagree: which bookings carry a join link, and whether the invitee
 * gets this service's own email for a change.
 */
describe('wantsConferencingLink', () => {
  it('an online meeting, or no location at all, carries a link', () => {
    expect(wantsConferencingLink('conferencing')).toBe(true);
    expect(wantsConferencingLink(null)).toBe(true);
    expect(wantsConferencingLink('')).toBe(true);
  });

  it('a place, a phone number, or a row queued before the kind existed does not', () => {
    for (const kind of ['in_person', 'phone', 'link', 'custom']) expect(wantsConferencingLink(kind), kind).toBe(false);
    expect(wantsConferencingLink(undefined)).toBe(false);
  });

  it('no kind but an address (a booking written before kinds) is not an online meeting', () => {
    expect(wantsConferencingLink(null, '12 Main St')).toBe(false);
    expect(wantsConferencingLink(null, '   ')).toBe(true);
    expect(wantsConferencingLink('conferencing', 'Zoom room 4')).toBe(true);
  });
});

describe('attendeeEmailedFor', () => {
  let db: Db;
  let accountId: string;

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code = 'acme'`))!.id;
  });

  it('defaults to yes for every change, as the outbox does', async () => {
    for (const kind of ['confirmation', 'reschedule', 'cancellation'] as const) {
      expect(await attendeeEmailedFor(db, accountId, kind), kind).toBe(true);
    }
  });

  it('follows the account toggle of that change only', async () => {
    await db.run(
      sql`INSERT INTO notification_setting (id, account_id, email_key, enabled, created_at, updated_at)
          VALUES (${randomUUID()}, ${accountId}, ${'attendee_reschedule'}, ${0}, ${Date.now()}, ${Date.now()})`,
    );
    expect(await attendeeEmailedFor(db, accountId, 'reschedule')).toBe(false);
    expect(await attendeeEmailedFor(db, accountId, 'confirmation')).toBe(true);
    expect(await attendeeEmailedFor(db, accountId, 'cancellation')).toBe(true);
  });
});
