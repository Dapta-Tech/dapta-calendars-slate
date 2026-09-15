import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import { claimAttribution, getAccountAttribution, hasDaptaSyncRow } from './growth';
import { enqueueOutbox } from './outbox';

/**
 * The growth data layer against a REAL Postgres. Its SQLite twin
 * (growth.spec.ts) owns the RULES; this file exists for the two places the
 * dialects genuinely differ and where SQLite would hide a break:
 *
 *  - `attribution` is `jsonb` here and `text` there, so the write goes through
 *    `jsonParam`'s `::jsonb` cast and the read comes back already parsed rather
 *    than as a string;
 *  - `claimed` is reported from `RETURNING` here and `changes()` there. They are
 *    different mechanisms for the same guarantee, so the guarantee has to be
 *    asserted on both. This one decides whether the funnel is told a new lead
 *    arrived, and a second `true` would be a second acquisition for one
 *    workspace.
 *
 * EVERY fixture here is created by this file and unique per run — a Postgres
 * DATABASE_URL is a persistent, SHARED database and other pg specs seed it
 * concurrently. Skipped on the SQLite dev default, like its neighbours.
 */
const url = process.env.DATABASE_URL ?? '';
const isPg = url.startsWith('postgres://') || url.startsWith('postgresql://');
const describePg = isPg ? describe : describe.skip;

const WINDOW_MS = 10 * 60_000;
const CAMPAIGN = { utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'q3-launch' };

describePg('growth attribution (real Postgres)', () => {
  let db: Db;

  beforeAll(async () => {
    db = await createDb(url);
    await migrate(db);
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  async function freshAccount(createdAt = Date.now()): Promise<string> {
    const id = randomUUID();
    await db.run(
      sql`INSERT INTO account (id, code, name, created_at)
          VALUES (${id}, ${'g' + id.slice(0, 7)}, ${'Growth Co'}, ${createdAt})`,
    );
    return id;
  }

  it('round-trips the blob through jsonb, parsed rather than stringified', async () => {
    const id = await freshAccount();
    const now = Date.now();
    const blob = { ...CAMPAIGN, referer: 'https://news.example.org/post/1' };

    const r = await claimAttribution(db, id, blob, { createdAfter: now - WINDOW_MS, now });
    expect(r.claimed).toBe(true);

    const state = await getAccountAttribution(db, id);
    expect(state.attribution).toEqual(blob);
    expect(typeof state.attribution).toBe('object');
    expect(state.claimedAt).toBe(now);
  });

  // The RETURNING half of the guarantee. Its SQLite twin covers `changes()`.
  it('reports claimed for exactly one of two writes sharing a millisecond', async () => {
    const id = await freshAccount();
    const now = Date.now();
    const opts = { createdAfter: now - WINDOW_MS, now };

    const a = await claimAttribution(db, id, CAMPAIGN, opts);
    const b = await claimAttribution(db, id, { utm_source: 'facebook' }, opts);

    expect([a.claimed, b.claimed].filter(Boolean)).toHaveLength(1);
    expect(b.reason).toBe('ALREADY_CLAIMED');
    // First touch wins, and the loser wrote nothing.
    expect((await getAccountAttribution(db, id)).attribution).toEqual(CAMPAIGN);
  });

  it('refuses an account older than the window', async () => {
    const now = Date.now();
    const id = await freshAccount(now - WINDOW_MS - 1);
    const r = await claimAttribution(db, id, CAMPAIGN, { createdAfter: now - WINDOW_MS, now });

    expect(r).toEqual({ claimed: false, reason: 'ACCOUNT_TOO_OLD' });
    expect((await getAccountAttribution(db, id)).attribution).toBeNull();
  });

  it('leaves an untouched account NULL — the migration backfills nothing', async () => {
    const state = await getAccountAttribution(db, await freshAccount());
    expect(state.attribution).toBeNull();
    expect(state.claimedAt).toBeNull();
  });

  it('finds an existing dapta_sync row regardless of its status', async () => {
    const id = await freshAccount();
    expect(await hasDaptaSyncRow(db, id, 'early')).toBe(false);

    const rowId = await enqueueOutbox(db, {
      kind: 'dapta_sync',
      action: 'early',
      accountId: id,
      payload: '{}',
    });
    await db.run(sql`UPDATE outbox SET status = 'failed' WHERE id = ${rowId}`);
    expect(await hasDaptaSyncRow(db, id, 'early')).toBe(true);
    expect(await hasDaptaSyncRow(db, id, 'complete')).toBe(false);
  });
});
