import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import { createBooking, getAvailability } from './repository';
import { createEventType } from './crud';
import { rescheduleBookingV2 } from './v2-pilot';

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
  /** The backfill that namespaces keys stored before this shipped. */
  const MIGRATION = '0015_scope_idempotency_keys.sql';

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

  async function slotList(t: Tenant): Promise<number[]> {
    const a = await getAvailability(db, {
      accountCode: t.code,
      handle: t.handle,
      slug: t.slug,
      fromMs: Date.now(),
      toMs: Date.now() + 10 * 86_400_000,
    });
    return (a?.slots ?? []).map((s) => new Date(s.startUtc).getTime());
  }

  async function firstSlotMs(t: Tenant): Promise<number> {
    return (await slotList(t))[0]!;
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

  it('a v2 reschedule replays its own key rather than moving twice', async () => {
    // `rescheduleBookingV2` writes the key on the new row and reads it back on
    // retry (#104). Its write and its three replay reads must namespace
    // identically; a mismatch would move the booking a second time instead of
    // reporting the first move, which is the whole point of the key.
    const a = await tenant('alpha');
    const start = await firstSlotMs(a);
    const created = await book(a, start, undefined);
    if (!created.ok) throw new Error('setup');
    const accountId = (
      await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code = ${a.code}`)
    )!.id;
    const target = (await slotList(a))[2]!;

    const moved = await rescheduleBookingV2(db, {
      accountId,
      uid: created.booking.uid,
      newStartMs: target,
      idempotencyKey: 'agent-reschedule-1',
    });
    expect(moved).toMatchObject({ ok: true });
    if (!moved.ok) return;
    expect(moved.alreadyApplied).toBeUndefined();

    const retry = await rescheduleBookingV2(db, {
      accountId,
      uid: created.booking.uid,
      newStartMs: (await slotList(a))[3]!,
      idempotencyKey: 'agent-reschedule-1',
    });
    expect(retry).toMatchObject({ ok: true, uid: moved.uid, alreadyApplied: true });

    // And the raw key never reached the column.
    const raw = await db.get<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM booking WHERE idempotency_key = ${'agent-reschedule-1'}`,
    );
    expect(Number(raw!.n)).toBe(0);
  });

  it('the account filter holds even when the stored key matches', async () => {
    // The namespace and the `account_id` filter are two separate guards, and
    // the namespace alone satisfies every assertion above — deleting the
    // filter would go unnoticed. This pins the filter on its own: account A is
    // made to hold a row whose stored key is exactly what a lookup under
    // account B computes, so key-only matching would hand B that row.
    const a = await tenant('alpha');
    const b = await tenant('beta');
    const created = await book(a, await firstSlotMs(a), 'a-own-key');
    if (!created.ok) throw new Error('setup');
    const bAccountId = (
      await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code = ${b.code}`)
    )!.id;
    await db.run(
      sql`UPDATE booking SET idempotency_key = ${`${bAccountId}:planted`}
          WHERE uid = ${created.booking.uid}`,
    );

    // B then books with that key. Reaching its own write means the lookup
    // missed, and that write collides with the planted row on the global
    // UNIQUE — a state only this fixture can produce, so the outcome is
    // allowed to be a refusal. What is NOT allowed is B being handed A's
    // booking as a replay, which is what key-only matching would do.
    const outcome = await book(b, await firstSlotMs(b), 'planted').catch(() => null);
    const replayedSomeoneElse =
      outcome !== null && outcome.ok && outcome.booking.uid === created.booking.uid;
    expect(replayedSomeoneElse).toBe(false);
  });

  it('the backfill migration namespaces keys stored before the fix', async () => {
    // Rows written before this shipped hold raw keys. Without the backfill
    // they stop replaying and keep occupying the raw key for every tenant.
    // Re-applying the migration proves its SQL, on the dialect it runs on.
    const a = await tenant('alpha');
    const start = await firstSlotMs(a);
    const created = await book(a, start, 'legacy-key');
    if (!created.ok) throw new Error('setup');
    // Put the row back the way the old code wrote it.
    await db.run(
      sql`UPDATE booking SET idempotency_key = ${'legacy-key'} WHERE uid = ${created.booking.uid}`,
    );
    // Same key, same slot: the replay no longer matches, so the request falls
    // through to the overlap guard instead of returning the prior booking.
    expect(await book(a, start, 'legacy-key')).toMatchObject({ ok: false });

    await db.run(sql`DELETE FROM _migrations WHERE name = ${MIGRATION}`);
    const applied = await migrate(db);
    expect(applied).toContain(MIGRATION);

    // Replay works again, and the raw key no longer holds the column.
    const replay = await book(a, start, 'legacy-key');
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.deduplicated).toBe(true);
    expect(replay.booking.uid).toBe(created.booking.uid);
    const raw = await db.get<{ n: number }>(
      sql`SELECT COUNT(*) AS n FROM booking WHERE idempotency_key = ${'legacy-key'}`,
    );
    expect(Number(raw!.n)).toBe(0);
  });

  it('the backfill clears a key shadowed by another tenant, in one application', async () => {
    // The nasty case: account C holds the literal string `<A>:k` while account
    // A holds the raw `k`. A's target is occupied at the moment the statement
    // runs, so the collision guard skips it — and the runner applies a file
    // once, so a single pass would leave A's row raw forever, which is the
    // exact harm this migration exists to undo. The statement is repeated for
    // that reason; this pins it.
    const a = await tenant('alpha');
    const c = await tenant('gamma');
    const aStart = await firstSlotMs(a);
    const aBooking = await book(a, aStart, 'k');
    const cBooking = await book(c, await firstSlotMs(c), 'shadow');
    if (!aBooking.ok || !cBooking.ok) throw new Error('setup');
    const aId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code = ${a.code}`))!
      .id;
    // Put both rows back in their pre-upgrade shape, C's shadowing A's target.
    await db.run(sql`UPDATE booking SET idempotency_key = ${'k'} WHERE uid = ${aBooking.booking.uid}`);
    await db.run(
      sql`UPDATE booking SET idempotency_key = ${`${aId}:k`} WHERE uid = ${cBooking.booking.uid}`,
    );

    await db.run(sql`DELETE FROM _migrations WHERE name = ${MIGRATION}`);
    await migrate(db);

    // Both rows namespaced, and A's replay resolves again.
    const aAfter = await db.get<{ k: string }>(
      sql`SELECT idempotency_key AS k FROM booking WHERE uid = ${aBooking.booking.uid}`,
    );
    expect(aAfter!.k).toBe(`${aId}:k`);
    const replay = await book(a, aStart, 'k');
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.deduplicated).toBe(true);
    expect(replay.booking.uid).toBe(aBooking.booking.uid);
  });

  it('the backfill leaves an already-namespaced row alone and is re-runnable', async () => {
    const a = await tenant('alpha');
    const start = await firstSlotMs(a);
    const created = await book(a, start, 'stable-key');
    if (!created.ok) throw new Error('setup');
    const before = await db.get<{ k: string }>(
      sql`SELECT idempotency_key AS k FROM booking WHERE uid = ${created.booking.uid}`,
    );

    await db.run(sql`DELETE FROM _migrations WHERE name = ${MIGRATION}`);
    await migrate(db);

    // Untouched — no double prefix, and the replay still resolves.
    const after = await db.get<{ k: string }>(
      sql`SELECT idempotency_key AS k FROM booking WHERE uid = ${created.booking.uid}`,
    );
    expect(after!.k).toBe(before!.k);
    const replay = await book(a, start, 'stable-key');
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.deduplicated).toBe(true);
    expect(replay.booking.uid).toBe(created.booking.uid);
  });
});
