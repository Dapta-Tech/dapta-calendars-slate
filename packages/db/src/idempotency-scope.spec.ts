import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import { createBooking, getAvailability } from './repository';
import { createEventType } from './crud';

/**
 * #104 — the idempotency key is per-account.
 *
 * `booking.idempotency_key` carries a GLOBAL `UNIQUE`, so before this the key
 * space was shared by every tenant: the replay lookup matched on the key alone
 * (one account's booking readable from another's request), and the first
 * account to store a string owned it forever (a second account reusing it
 * collided on insert and could never book with it). Both halves are asserted
 * here through the public create path, which is where a key arrives.
 */
describe('#104 — booking idempotency keys are account-scoped', () => {
  let db: Db;

  // The example key the API reference prints for the machine surface. Two
  // tenants driving the same automation template really do emit this string.
  const KEY = 'flow-run-123:create-booking';

  interface Tenant {
    accountId: string;
    code: string;
    handle: string;
    slug: string;
    email: string;
  }

  /** A whole tenant: account, host, Mon–Fri 09:00–17:00 schedule, event type. */
  async function tenant(name: string): Promise<Tenant> {
    const accountId = randomUUID();
    const memberId = randomUUID();
    const scheduleId = randomUUID();
    const now = Date.now();
    const code = `acct-${name}`;
    const handle = `host-${name}`;
    await db.run(
      sql`INSERT INTO account (id, code, name, created_at)
          VALUES (${accountId}, ${code}, ${name}, ${now})`,
    );
    await db.run(
      sql`INSERT INTO member (id, account_id, handle, display_name, email, time_zone,
            default_schedule_id, created_at)
          VALUES (${memberId}, ${accountId}, ${handle}, ${name}, ${`${name}@example.com`},
            ${'America/New_York'}, ${scheduleId}, ${now})`,
    );
    await db.run(
      sql`INSERT INTO schedule (id, account_id, member_id, name, time_zone, created_at)
          VALUES (${scheduleId}, ${accountId}, ${memberId}, ${'Working Hours'},
            ${'America/New_York'}, ${now})`,
    );
    await db.run(
      sql`INSERT INTO availability (id, schedule_id, days, start_time, end_time, date)
          VALUES (${randomUUID()}, ${scheduleId}, ${JSON.stringify([1, 2, 3, 4, 5])},
            ${'09:00'}, ${'17:00'}, ${null})`,
    );
    const slug = 'intro-call';
    const ev = await createEventType(db, accountId, memberId, {
      slug,
      title: 'Intro Call',
      lengthMinutes: 30,
      scheduleId,
    });
    expect(ev.ok).toBe(true);
    return { accountId, code, handle, slug, email: `booker-${name}@example.com` };
  }

  async function firstSlotMs(t: Tenant): Promise<number> {
    const a = await getAvailability(db, {
      accountCode: t.code,
      handle: t.handle,
      slug: t.slug,
      fromMs: Date.now(),
      toMs: Date.now() + 10 * 86_400_000,
    });
    return new Date(a!.slots[0]!.startUtc).getTime();
  }

  function book(t: Tenant, startMs: number, idempotencyKey?: string) {
    return createBooking(db, {
      accountCode: t.code,
      handle: t.handle,
      slug: t.slug,
      startMs,
      attendee: { name: 'Pat', email: t.email, timeZone: 'America/New_York' },
      idempotencyKey,
    });
  }

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
  });

  it('two accounts sending the same key each get their own booking', async () => {
    const a = await tenant('alpha');
    const b = await tenant('beta');

    const first = await book(a, await firstSlotMs(a), KEY);
    const second = await book(b, await firstSlotMs(b), KEY);

    // The second account must not be locked out by the first account's key.
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.booking.uid).not.toBe(first.booking.uid);
    // Neither is a replay of the other: both minted their own manage token.
    expect(first.deduplicated).toBeUndefined();
    expect(second.deduplicated).toBeUndefined();
    expect(second.manageToken).not.toBe('');
  });

  it('a repeated key replays only its own account, never the other tenant', async () => {
    const a = await tenant('alpha');
    const b = await tenant('beta');
    const aStart = await firstSlotMs(a);
    const bStart = await firstSlotMs(b);

    const aFirst = await book(a, aStart, KEY);
    const bFirst = await book(b, bStart, KEY);
    if (!aFirst.ok || !bFirst.ok) throw new Error('setup');

    const aReplay = await book(a, aStart, KEY);
    const bReplay = await book(b, bStart, KEY);
    expect(aReplay.ok).toBe(true);
    expect(bReplay.ok).toBe(true);
    if (!aReplay.ok || !bReplay.ok) return;

    // Each side replays its own booking, with its own attendee.
    expect(aReplay.deduplicated).toBe(true);
    expect(aReplay.booking.uid).toBe(aFirst.booking.uid);
    expect(aReplay.booking.attendee.email).toBe(a.email);

    expect(bReplay.deduplicated).toBe(true);
    expect(bReplay.booking.uid).toBe(bFirst.booking.uid);
    expect(bReplay.booking.attendee.email).toBe(b.email);

    // The read the ticket is about: a key must never surface the other
    // tenant's uid, host or attendee.
    expect(bReplay.booking.uid).not.toBe(aFirst.booking.uid);
    expect(bReplay.booking.attendee.email).not.toBe(a.email);
    expect(aReplay.booking.attendee.email).not.toBe(b.email);
  });

  it('a key an account never used replays nothing from another account', async () => {
    const a = await tenant('alpha');
    const b = await tenant('beta');
    const aFirst = await book(a, await firstSlotMs(a), KEY);
    if (!aFirst.ok) throw new Error('setup');

    // B has never used this key. It must create, not replay A's booking.
    const bFresh = await book(b, await firstSlotMs(b), KEY);
    expect(bFresh.ok).toBe(true);
    if (!bFresh.ok) return;
    expect(bFresh.deduplicated).toBeUndefined();
    expect(bFresh.booking.uid).not.toBe(aFirst.booking.uid);
    expect(bFresh.booking.hostHandle).toBe(b.handle);
  });

  it('never stores the raw key, so the global UNIQUE cannot be squatted', async () => {
    const a = await tenant('alpha');
    const created = await book(a, await firstSlotMs(a), KEY);
    expect(created.ok).toBe(true);

    // The stored value is namespaced by account. This is what keeps one
    // tenant's key from occupying the column for everyone else; the shape of
    // the namespace is deliberately not asserted, only that the bare key is
    // not it.
    const raw = await db.get<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM booking WHERE idempotency_key = ${KEY}`,
    );
    expect(Number(raw!.n)).toBe(0);
    const stored = await db.get<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM booking WHERE idempotency_key IS NOT NULL`,
    );
    expect(Number(stored!.n)).toBe(1);
  });
});
