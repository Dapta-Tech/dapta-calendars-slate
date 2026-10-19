import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import { claimDueOutbox, enqueueOutbox, markOutboxDone, markOutboxRetry, type OutboxKind } from './outbox';

// Several API replicas drain one outbox. The claim is what keeps two of them
// from delivering the same row (the same email twice, the same webhook twice),
// and on Postgres that rests on the conditional UPDATE being re-checked against
// a row another connection just leased. Two separate connection pools stand in
// for two replicas. Skipped on the SQLite default.
const url = process.env.DATABASE_URL ?? '';
const isPg = url.startsWith('postgres://') || url.startsWith('postgresql://');
const describePg = isPg ? describe : describe.skip;

describePg('outbox claims across replicas (real Postgres)', () => {
  let a: Db;
  let b: Db;
  // A kind of this run's own: the database is shared with other spec files, and
  // a claim must not take (or be starved by) rows another file is working on.
  const kind = `race-${randomUUID().slice(0, 8)}` as OutboxKind;

  beforeAll(async () => {
    a = await createDb(url);
    b = await createDb(url);
    await migrate(a);
  });

  afterAll(async () => {
    await a.run(sql`DELETE FROM outbox WHERE kind = ${kind}`);
    await a.close();
    await b.close();
  });

  it('two replicas claiming at once never take the same row, and between them take every row', async () => {
    const n = 60;
    for (let i = 0; i < n; i++) {
      await enqueueOutbox(a, { kind, action: 'x', bookingUid: `bk-${i}`, payload: '{}', now: 0 });
    }
    const seen: string[] = [];
    // Rounds of simultaneous claims, as two polling replicas would make them.
    for (let round = 0; round < 10 && seen.length < n; round++) {
      const [ra, rb] = await Promise.all([
        claimDueOutbox(a, 1 + round, 25, { kinds: [kind], token: `a${round}`, leaseMs: 60_000 }),
        claimDueOutbox(b, 1 + round, 25, { kinds: [kind], token: `b${round}`, leaseMs: 60_000 }),
      ]);
      for (const row of [...ra, ...rb]) {
        seen.push(row.id);
        await markOutboxDone(a, row.id, 2 + round, row.leaseToken);
      }
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(n);
  });

  it('a lease held on one replica keeps the other off the row until it runs out', async () => {
    const id = await enqueueOutbox(a, { kind, action: 'y', bookingUid: 'bk-lease', payload: '{}', now: 0 });
    const held = await claimDueOutbox(a, 1_000, 10, { kinds: [kind], token: 'a', leaseMs: 30_000 });
    expect(held.map((r) => r.id)).toEqual([id]);
    expect(await claimDueOutbox(b, 20_000, 10, { kinds: [kind], token: 'b' })).toHaveLength(0);
    const taken = await claimDueOutbox(b, 31_000, 10, { kinds: [kind], token: 'b', leaseMs: 30_000 });
    expect(taken.map((r) => r.id)).toEqual([id]);
    // The replica whose lease ran out cannot record over the new holder.
    expect(await markOutboxDone(a, id, 31_500, 'a')).toBe(false);
    expect(await markOutboxDone(b, id, 31_500, 'b')).toBe(true);
  });

  it('in order, racing: a key\'s second row is never claimed while its first is in flight or backing off', async () => {
    const tag = randomUUID().slice(0, 8);
    const opts = (token: string) => ({ kinds: [kind], inOrder: true, token, leaseMs: 60_000 });
    // Three keys, three rows each, queued in order.
    const ids: Record<string, string[]> = {};
    let t = 100_000;
    for (const key of ['k1', 'k2', 'k3']) {
      ids[key] = [];
      for (let i = 0; i < 3; i++) {
        ids[key]!.push(
          await enqueueOutbox(a, { kind, action: `${key}-${i}`, bookingUid: `${tag}-${key}`, payload: '{}', now: t++ }),
        );
      }
    }
    const at = t + 10;
    const [ra, rb] = await Promise.all([claimDueOutbox(a, at, 10, opts('a')), claimDueOutbox(b, at, 10, opts('b'))]);
    const claimed = [...ra, ...rb].map((r) => r.id).sort();
    // Exactly the three heads, each once, whichever pool won it.
    expect(claimed).toEqual([ids.k1![0]!, ids.k2![0]!, ids.k3![0]!].sort());
    // While the heads are in flight, nothing more of those keys.
    expect(await claimDueOutbox(b, at + 1, 10, opts('c'))).toHaveLength(0);
    // k1's head fails and backs off: k1 waits, the others' next rows go once their heads are done.
    const head = (key: string) => [...ra, ...rb].find((r) => r.id === ids[key]![0])!;
    await markOutboxRetry(a, ids.k1![0]!, { attempts: 1, error: 'x', now: at + 2, delayMs: 60_000, leaseToken: head('k1').leaseToken });
    await markOutboxDone(a, ids.k2![0]!, at + 2, head('k2').leaseToken);
    await markOutboxDone(a, ids.k3![0]!, at + 2, head('k3').leaseToken);
    const next = await claimDueOutbox(a, at + 3, 10, opts('d'));
    expect(next.map((r) => r.id).sort()).toEqual([ids.k2![1]!, ids.k3![1]!].sort());
  });

  it('webhooks, racing: one head per subscriber, none for a subscriber already in flight', async () => {
    const tag = randomUUID().slice(0, 8);
    const [s1, s2, s3] = [`${tag}-s1`, `${tag}-s2`, `${tag}-s3`];
    const mine = new Set<string>();
    let t = 200_000;
    // Three bookings' events each for s1 and s2, one for s3, which is already busy.
    for (const sub of [s1, s2]) {
      for (let i = 0; i < 3; i++) {
        mine.add(
          await enqueueOutbox(a, { kind: 'webhook', action: 'booking.created', webhookId: sub, bookingUid: `${sub}-b${i}`, payload: '{}', now: t++ }),
        );
      }
    }
    const busy = await enqueueOutbox(a, { kind: 'webhook', action: 'booking.created', webhookId: s3, bookingUid: `${s3}-b0`, payload: '{}', now: t++ });
    const queued = await enqueueOutbox(a, { kind: 'webhook', action: 'booking.created', webhookId: s3, bookingUid: `${s3}-b1`, payload: '{}', now: t++ });
    mine.add(busy).add(queued);
    const at = t + 10;
    await a.run(sql`UPDATE outbox SET lease_until = ${at + 60_000}, lease_token = ${'elsewhere'} WHERE id = ${busy}`);
    const tokens = [`${tag}-a`, `${tag}-b`];
    try {
      const [ra, rb] = await Promise.all([
        claimDueOutbox(a, at, 20, { kinds: ['webhook'], inOrder: true, token: tokens[0] }),
        claimDueOutbox(b, at, 20, { kinds: ['webhook'], inOrder: true, token: tokens[1] }),
      ]);
      const got = [...ra, ...rb].filter((r) => mine.has(r.id));
      const perSubscriber = (sub: string) => got.filter((r) => r.webhookId === sub).length;
      // No row twice, s3 untouched while it is busy, and each idle subscriber
      // at least once and, within one claim, at most once.
      expect(new Set(got.map((r) => r.id)).size).toBe(got.length);
      expect(perSubscriber(s3)).toBe(0);
      expect(perSubscriber(s1)).toBeGreaterThanOrEqual(1);
      expect(perSubscriber(s2)).toBeGreaterThanOrEqual(1);
      for (const claim of [ra, rb]) {
        for (const sub of [s1, s2]) expect(claim.filter((r) => r.webhookId === sub).length).toBeLessThanOrEqual(1);
      }
    } finally {
      // Give back anything of another file's this claim may have leased.
      await a.run(
        sql`UPDATE outbox SET lease_until = NULL, lease_token = NULL
            WHERE lease_token IN (${tokens[0]}, ${tokens[1]}) AND webhook_id NOT IN (${s1}, ${s2}, ${s3})`,
      );
      await a.run(sql`DELETE FROM outbox WHERE webhook_id IN (${s1}, ${s2}, ${s3})`);
    }
  });
});
