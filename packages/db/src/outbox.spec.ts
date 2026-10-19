import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, type Db } from './client';
import { migrate } from './migrate';
import { sql } from 'drizzle-orm';
import {
  backoffMs,
  claimDueOutbox,
  countOutbox,
  defaultOrderKey,
  enqueueOutbox,
  listOutbox,
  markOutboxDone,
  markOutboxFailed,
  markOutboxRetry,
  MAX_BACKOFF_MS,
  outboxRetriesExhausted,
  renewOutboxLease,
  retryDelayMs,
} from './outbox';

describe('outbox — durable side-effect queue (B7/DM1)', () => {
  let db: Db;
  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
  });

  it('enqueue → claimDue returns the row once it is due', async () => {
    await enqueueOutbox(db, { kind: 'calendar', action: 'create', bookingUid: 'bk-1', now: 1000 });
    // Not yet due.
    expect(await claimDueOutbox(db, 999)).toHaveLength(0);
    // Due.
    const due = await claimDueOutbox(db, 1000);
    expect(due).toHaveLength(1);
    expect(due[0]!.kind).toBe('calendar');
    expect(due[0]!.action).toBe('create');
    expect(due[0]!.bookingUid).toBe('bk-1');
    expect(due[0]!.status).toBe('pending');
    expect(due[0]!.attempts).toBe(0);
  });

  it('markDone removes a row from the due set', async () => {
    const id = await enqueueOutbox(db, { kind: 'webhook', action: 'booking.created', webhookId: 'w1', payload: '{}', now: 0 });
    await markOutboxDone(db, id, 5);
    expect(await claimDueOutbox(db, 10)).toHaveLength(0);
    expect(await countOutbox(db, 'done')).toBe(1);
    expect(await countOutbox(db, 'pending')).toBe(0);
  });

  it('markRetry bumps attempts, records the error, and reschedules with backoff', async () => {
    const id = await enqueueOutbox(db, { kind: 'calendar', action: 'create', bookingUid: 'bk-1', now: 0 });
    await markOutboxRetry(db, id, { attempts: 1, error: 'boom', now: 100 });
    // Still pending but not due until now + backoff(1) = 100 + 1000.
    expect(await claimDueOutbox(db, 100)).toHaveLength(0);
    const due = await claimDueOutbox(db, 100 + backoffMs(1));
    expect(due).toHaveLength(1);
    expect(due[0]!.attempts).toBe(1);
    expect(due[0]!.lastError).toBe('boom');
  });

  it('markFailed is terminal — never re-served, kept as the log', async () => {
    const id = await enqueueOutbox(db, { kind: 'webhook', action: 'x', webhookId: 'w', payload: '{}', now: 0 });
    await markOutboxFailed(db, id, { attempts: 5, error: 'gave up', now: 10 });
    expect(await claimDueOutbox(db, 1_000_000)).toHaveLength(0);
    const failed = await listOutbox(db, { status: 'failed' });
    expect(failed).toHaveLength(1);
    expect(failed[0]!.lastError).toBe('gave up');
    expect(failed[0]!.attempts).toBe(5);
  });

  it('backoffMs is exponential and capped at 15 minutes', () => {
    expect(backoffMs(1)).toBe(1000);
    expect(backoffMs(2)).toBe(2000);
    expect(backoffMs(3)).toBe(4000);
    expect(backoffMs(10)).toBe(512_000);
    expect(backoffMs(11)).toBe(15 * 60_000);
    expect(backoffMs(100)).toBe(15 * 60_000);
  });

  it('retryDelayMs spreads a retry over 80-100% of the plain backoff, never past it', () => {
    expect(retryDelayMs(1, () => 0)).toBe(800);
    expect(retryDelayMs(1, () => 1)).toBe(1000);
    expect(retryDelayMs(4, () => 0.5)).toBe(7200);
    for (let i = 0; i < 50; i++) {
      const d = retryDelayMs(6);
      expect(d).toBeGreaterThanOrEqual(0.8 * backoffMs(6));
      expect(d).toBeLessThanOrEqual(backoffMs(6));
    }
  });

  it('retries end only when the attempt budget is spent AND the horizon has passed', () => {
    const row = { maxAttempts: 5, firstFailedAt: 1_000 };
    const hour = 3_600_000;
    // Budget not spent: keep going, however long it has been failing.
    expect(outboxRetriesExhausted(row, 4, 1_000 + 10 * hour, hour)).toBe(false);
    // Budget spent, still inside the horizon: keep going.
    expect(outboxRetriesExhausted(row, 5, 1_000 + hour - 1, hour)).toBe(false);
    // Both: done.
    expect(outboxRetriesExhausted(row, 5, 1_000 + hour, hour)).toBe(true);
    // A horizon of 0 is the old rule: the budget alone decides.
    expect(outboxRetriesExhausted(row, 5, 1_000, 0)).toBe(true);
    // A row that never failed before counts its horizon from now.
    expect(outboxRetriesExhausted({ maxAttempts: 1, firstFailedAt: null }, 1, 5_000, hour)).toBe(false);
  });

  it('a retry is scheduled from the failure, remembers the first failure, and honours delayMs', async () => {
    const id = await enqueueOutbox(db, { kind: 'webhook', action: 'x', webhookId: 'w', payload: '{}', now: 0 });
    await markOutboxRetry(db, id, { attempts: 1, error: 'a', now: 10_000, delayMs: 900 });
    let row = (await listOutbox(db))[0]!;
    expect(row.nextAttemptAt).toBe(10_900);
    expect(row.firstFailedAt).toBe(10_000);
    await markOutboxRetry(db, id, { attempts: 2, error: 'b', now: 20_000 });
    row = (await listOutbox(db))[0]!;
    expect(row.nextAttemptAt).toBe(20_000 + backoffMs(2));
    // The FIRST failure stays: the horizon counts from it.
    expect(row.firstFailedAt).toBe(10_000);
  });

  it('a claim leases its rows: claimed again only once the lease has run out', async () => {
    await enqueueOutbox(db, { kind: 'email', action: 'confirmation', bookingUid: 'b1', payload: '{}', now: 0 });
    const first = await claimDueOutbox(db, 100, 10, { leaseMs: 60_000, token: 'worker-a' });
    expect(first).toHaveLength(1);
    expect(first[0]!.leaseToken).toBe('worker-a');
    expect(first[0]!.leaseUntil).toBe(60_100);
    // Another worker (another replica) finds nothing while the lease holds.
    expect(await claimDueOutbox(db, 30_000, 10, { token: 'worker-b' })).toHaveLength(0);
    // The holder died: once the lease runs out the row is someone else's.
    const taken = await claimDueOutbox(db, 60_100, 10, { leaseMs: 60_000, token: 'worker-b' });
    expect(taken.map((r) => r.leaseToken)).toEqual(['worker-b']);
    // The first worker's late outcome cannot overwrite the new holder's.
    expect(await markOutboxDone(db, taken[0]!.id, 60_200, 'worker-a')).toBe(false);
    expect((await listOutbox(db))[0]!.status).toBe('pending');
    expect(await markOutboxDone(db, taken[0]!.id, 60_200, 'worker-b')).toBe(true);
    expect((await listOutbox(db))[0]!.status).toBe('done');
  });

  it('a live delivery renews its lease; a lost one cannot', async () => {
    await enqueueOutbox(db, { kind: 'calendar', action: 'create', bookingUid: 'b1', now: 0 });
    const [row] = await claimDueOutbox(db, 0, 1, { leaseMs: 10_000, token: 't1' });
    expect(await renewOutboxLease(db, row!.id, 't1', 50_000)).toBe(true);
    expect(await claimDueOutbox(db, 20_000, 1, { token: 't2' })).toHaveLength(0);
    expect(await renewOutboxLease(db, row!.id, 'someone-else', 90_000)).toBe(false);
  });

  it('one destination contributes one row per claim, and none while it has one in flight', async () => {
    // Three deliveries to subscriber A, one to B, one to C.
    for (let i = 0; i < 3; i++)
      await enqueueOutbox(db, { kind: 'webhook', action: `a${i}`, webhookId: 'A', payload: '{}', now: i });
    await enqueueOutbox(db, { kind: 'webhook', action: 'b', webhookId: 'B', payload: '{}', now: 10 });
    await enqueueOutbox(db, { kind: 'webhook', action: 'c', webhookId: 'C', payload: '{}', now: 11 });
    const opts = { kinds: ['webhook'] as const, inOrder: true, leaseMs: 60_000 };
    const first = await claimDueOutbox(db, 100, 10, opts);
    // A's OLDEST, then B and C: A's backlog takes one slot, not every slot.
    expect(first.map((r) => r.action)).toEqual(['a0', 'b', 'c']);
    // While a0 is in flight, A contributes nothing more.
    expect(await claimDueOutbox(db, 200, 10, opts)).toHaveLength(0);
    await markOutboxDone(db, first[0]!.id, 300, first[0]!.leaseToken);
    expect((await claimDueOutbox(db, 400, 10, opts)).map((r) => r.action)).toEqual(['a1']);
  });

  it('in order per destination: a row backing off holds the rows queued after it', async () => {
    const opts = { kinds: ['calendar'] as const, inOrder: true, leaseMs: 60_000 };
    // The booking's create, then (the visitor cancels) its delete.
    const create = await enqueueOutbox(db, { kind: 'calendar', action: 'create', bookingUid: 'b1', now: 0 });
    const del = await enqueueOutbox(db, { kind: 'calendar', action: 'delete', bookingUid: 'b1', now: 1 });
    const [first] = await claimDueOutbox(db, 10, 10, opts);
    expect(first!.id).toBe(create);
    // The create fails and backs off: the delete, due now, must NOT overtake it.
    await markOutboxRetry(db, create, { attempts: 1, error: 'backend down', now: 20, delayMs: 60_000, leaseToken: first!.leaseToken });
    expect(await claimDueOutbox(db, 30, 10, opts)).toHaveLength(0);
    // The create comes due again and goes first; only after it, the delete.
    const [again] = await claimDueOutbox(db, 60_020, 10, opts);
    expect(again!.id).toBe(create);
    expect(await claimDueOutbox(db, 60_030, 10, opts)).toHaveLength(0);
    await markOutboxDone(db, create, 60_040, again!.leaseToken);
    expect((await claimDueOutbox(db, 60_050, 10, opts)).map((r) => r.id)).toEqual([del]);
  });

  it('in order per destination: a row scheduled for later and never tried blocks nobody', async () => {
    const opts = { kinds: ['email'] as const, inOrder: true };
    // A reminder queued weeks ahead, then a cancellation due now.
    await enqueueOutbox(db, { kind: 'email', action: 'reminder', bookingUid: 'b1', payload: '{}', now: 0, nextAttemptAt: 30 * 86_400_000 });
    const cancel = await enqueueOutbox(db, { kind: 'email', action: 'cancellation', bookingUid: 'b1', payload: '{}', now: 10 });
    expect((await claimDueOutbox(db, 20, 10, opts)).map((r) => r.id)).toEqual([cancel]);
  });

  it("a subscriber's events keep their order per booking, without holding its other bookings' events", async () => {
    const opts = { kinds: ['webhook'] as const, inOrder: true, leaseMs: 60_000 };
    const created1 = await enqueueOutbox(db, { kind: 'webhook', action: 'booking.created', webhookId: 'A', bookingUid: 'b1', payload: '{}', now: 0 });
    const cancelled1 = await enqueueOutbox(db, { kind: 'webhook', action: 'booking.cancelled', webhookId: 'A', bookingUid: 'b1', payload: '{}', now: 1 });
    const created2 = await enqueueOutbox(db, { kind: 'webhook', action: 'booking.created', webhookId: 'A', bookingUid: 'b2', payload: '{}', now: 2 });
    const [first] = await claimDueOutbox(db, 10, 10, opts);
    expect(first!.id).toBe(created1);
    // One subscriber, one delivery in flight: nothing else of A while it runs.
    expect(await claimDueOutbox(db, 11, 10, opts)).toHaveLength(0);
    await markOutboxRetry(db, created1, { attempts: 1, error: 'HTTP 503', now: 20, delayMs: 60_000, leaseToken: first!.leaseToken });
    // b1's cancellation waits behind its creation; b2's event does not.
    expect((await claimDueOutbox(db, 30, 10, opts)).map((r) => r.id)).toEqual([created2]);
    expect(cancelled1).toBeTruthy();
  });

  it("one side's mail never waits on the other side's: an invitee address refused does not hold up the host", async () => {
    const opts = { kinds: ['email'] as const, inOrder: true, leaseMs: 60_000 };
    const attendee = await enqueueOutbox(db, { kind: 'email', action: 'confirmation', bookingUid: 'b1', orderKey: 'b1|attendee', payload: '{}', now: 0 });
    const host = await enqueueOutbox(db, { kind: 'email', action: 'confirmation', bookingUid: 'b1', orderKey: 'b1|host', payload: '{}', now: 1 });
    const both = await claimDueOutbox(db, 10, 10, opts);
    expect(both.map((r) => r.id).sort()).toEqual([attendee, host].sort());
    const a = both.find((r) => r.id === attendee)!;
    await markOutboxRetry(db, attendee, { attempts: 1, error: '550 no such user', now: 20, delayMs: 60_000, leaseToken: a.leaseToken });
    const cancelHost = await enqueueOutbox(db, { kind: 'email', action: 'cancellation', bookingUid: 'b1', orderKey: 'b1|host', payload: '{}', now: 30 });
    await markOutboxDone(db, host, 40, both.find((r) => r.id === host)!.leaseToken);
    expect((await claimDueOutbox(db, 50, 10, opts)).map((r) => r.id)).toEqual([cancelHost]);
  });

  it('the default order key: the booking, or for a webhook the subscriber and the booking', () => {
    expect(defaultOrderKey({ kind: 'calendar', bookingUid: 'b1' })).toBe('b1');
    expect(defaultOrderKey({ kind: 'webhook', webhookId: 'w', bookingUid: 'b1' })).toBe('w|b1');
    expect(defaultOrderKey({ kind: 'webhook', webhookId: 'w' })).toBe('w');
    expect(defaultOrderKey({ kind: 'dapta_sync' })).toBeNull();
  });

  it('a retry is never scheduled past MAX_BACKOFF_MS, so an in-order claim always sees it', async () => {
    const id = await enqueueOutbox(db, { kind: 'webhook', action: 'x', webhookId: 'w', payload: '{}', now: 0 });
    await markOutboxRetry(db, id, { attempts: 1, error: 'x', now: 0, delayMs: 10 * 3_600_000 });
    expect((await listOutbox(db))[0]!.nextAttemptAt).toBe(MAX_BACKOFF_MS);
  });

  it('a lane claims only its kinds; the catch-all lane takes the rest', async () => {
    await enqueueOutbox(db, { kind: 'email', action: 'confirmation', bookingUid: 'b1', payload: '{}', now: 0 });
    await enqueueOutbox(db, { kind: 'webhook', action: 'x', webhookId: 'w', payload: '{}', now: 0 });
    await db.run(
      sql`INSERT INTO outbox (id, kind, action, status, attempts, max_attempts, next_attempt_at, created_at, updated_at)
          VALUES ('odd', 'mystery', 'x', 'pending', 0, 5, 0, 0, 0)`,
    );
    expect((await claimDueOutbox(db, 1, 10, { kinds: ['email'] })).map((r) => r.kind)).toEqual(['email']);
    expect(
      (await claimDueOutbox(db, 1, 10, { excludeKinds: ['email', 'webhook', 'calendar'] })).map((r) => r.id),
    ).toEqual(['odd']);
  });

  it('two claimers racing over the same rows never both win one', async () => {
    for (let i = 0; i < 20; i++)
      await enqueueOutbox(db, { kind: 'email', action: 'confirmation', bookingUid: `b${i}`, payload: '{}', now: 0 });
    const [a, b] = await Promise.all([
      claimDueOutbox(db, 1, 15, { token: 'a' }),
      claimDueOutbox(db, 1, 15, { token: 'b' }),
    ]);
    const ids = [...a, ...b].map((r) => r.id);
    // Disjoint: a row a claimer lost is simply not in its batch.
    expect(new Set(ids).size).toBe(ids.length);
    // Whatever neither won this time is claimed next time, once.
    const rest = await claimDueOutbox(db, 2, 50, { token: 'c' });
    const all = [...ids, ...rest.map((r) => r.id)];
    expect(new Set(all).size).toBe(20);
    expect(all).toHaveLength(20);
  });

  it('claimDue returns oldest-due first', async () => {
    await enqueueOutbox(db, { kind: 'calendar', action: 'create', bookingUid: 'b', now: 300 });
    await enqueueOutbox(db, { kind: 'calendar', action: 'delete', bookingUid: 'a', now: 100 });
    const due = await claimDueOutbox(db, 1000);
    expect(due.map((r) => r.action)).toEqual(['delete', 'create']);
  });
});
