import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import { claimDueOutbox, enqueueOutbox, markOutboxDone, type OutboxKind } from './outbox';

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
});
