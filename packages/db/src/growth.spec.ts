import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createDb, type Db } from './client';
import { migrate } from './migrate';
import { seed } from './seed';
import { claimAttribution, getAccountAttribution, hasDaptaSyncRow } from './growth';
import { enqueueOutbox } from './outbox';

const CAMPAIGN = { utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'q3-launch' };

/**
 * A local stand-in for the policy, NOT an import. `claimAttribution` takes an
 * absolute cutoff precisely so `@slate/db` carries no attribution policy and
 * needs no dependency on `@slate/shared`. That the cutoff the API computes is
 * really `ATTRIBUTION_WINDOW_MS` is asserted in the API's growth spec, which
 * depends on both packages.
 */
const ATTRIBUTION_WINDOW_MS = 10 * 60_000;

describe('growth attribution (O2, #94)', () => {
  let db: Db;
  /** A brand-new account, inside the claim window. */
  let fresh: string;
  const now = 1_800_000_000_000;
  const createdAfter = now - ATTRIBUTION_WINDOW_MS;

  async function makeAccount(createdAt: number): Promise<string> {
    const id = randomUUID();
    await db.run(
      sql`INSERT INTO account (id, code, name, created_at)
          VALUES (${id}, ${'c' + id.slice(0, 5)}, ${'New Co'}, ${createdAt})`,
    );
    return id;
  }

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    fresh = await makeAccount(now - 1000);
  });

  // --- The migration's deliberate non-backfill -----------------------------

  it('leaves every pre-existing account unattributed — nothing is backfilled', async () => {
    // The inverse of O1's stamping migration. NULL here is truthful: no
    // attribution was ever captured. A synthetic value could never be undone.
    const acme = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code='acme'`))!.id;
    const state = await getAccountAttribution(db, acme);
    expect(state.claimedAt).toBeNull();
    expect(state.attribution).toBeNull();
  });

  // --- Write-once ---------------------------------------------------------

  it('claims a fresh account and stores the blob', async () => {
    const r = await claimAttribution(db, fresh, CAMPAIGN, { createdAfter, now });
    expect(r.claimed).toBe(true);

    const state = await getAccountAttribution(db, fresh);
    expect(state.attribution).toEqual(CAMPAIGN);
    expect(state.claimedAt).toBe(now);
  });

  it('refuses a second claim and keeps the FIRST touch', async () => {
    await claimAttribution(db, fresh, CAMPAIGN, { createdAfter, now });
    const second = await claimAttribution(
      db,
      fresh,
      { utm_source: 'facebook', utm_campaign: 'retarget' },
      { createdAfter, now: now + 1 },
    );

    expect(second.claimed).toBe(false);
    expect(second.reason).toBe('ALREADY_CLAIMED');
    // First touch wins: the stored blob and its timestamp are untouched.
    const state = await getAccountAttribution(db, fresh);
    expect(state.attribution).toEqual(CAMPAIGN);
    expect(state.claimedAt).toBe(now);
  });

  it('reports claimed for exactly one of two writes sharing a millisecond', async () => {
    // `claimed` drives the funnel's "a new lead arrived" signal, so two winners
    // would be two attributed acquisitions for one workspace. The count comes
    // from the write itself, not from comparing timestamps back.
    const a = await claimAttribution(db, fresh, CAMPAIGN, { createdAfter, now });
    const b = await claimAttribution(db, fresh, CAMPAIGN, { createdAfter, now });
    expect([a.claimed, b.claimed].filter(Boolean)).toHaveLength(1);
  });

  // --- The ten-minute window ----------------------------------------------

  it('refuses an account older than the window', async () => {
    // The owner of an established workspace clicking a campaign link must not
    // restamp its origin.
    const old = await makeAccount(now - ATTRIBUTION_WINDOW_MS - 1);
    const r = await claimAttribution(db, old, CAMPAIGN, { createdAfter, now });

    expect(r.claimed).toBe(false);
    expect(r.reason).toBe('ACCOUNT_TOO_OLD');
    expect((await getAccountAttribution(db, old)).attribution).toBeNull();
  });

  it('accepts an account right at the edge of the window', async () => {
    const edge = await makeAccount(createdAfter + 1);
    expect((await claimAttribution(db, edge, CAMPAIGN, { createdAfter, now })).claimed).toBe(true);
  });

  it('reports NO_ACCOUNT rather than throwing for an unknown account', async () => {
    const r = await claimAttribution(db, randomUUID(), CAMPAIGN, { createdAfter, now });
    expect(r).toEqual({ claimed: false, reason: 'NO_ACCOUNT' });
  });

  it('round-trips a blob carrying a cross-origin referer', async () => {
    const blob = { ...CAMPAIGN, referer: 'https://news.example.org/post/1' };
    await claimAttribution(db, fresh, blob, { createdAfter, now });
    expect((await getAccountAttribution(db, fresh)).attribution).toEqual(blob);
  });

  // --- The early-fire dedupe ----------------------------------------------

  describe('hasDaptaSyncRow', () => {
    it('is false before anything is enqueued', async () => {
      expect(await hasDaptaSyncRow(db, fresh, 'early')).toBe(false);
    });

    it('is true once an early row exists, so the wizard cannot re-push a lead', async () => {
      await enqueueOutbox(db, { kind: 'dapta_sync', action: 'early', accountId: fresh, payload: '{}', now });
      expect(await hasDaptaSyncRow(db, fresh, 'early')).toBe(true);
    });

    it('stays true for a row that already failed — the delivery had its retries', async () => {
      const id = await enqueueOutbox(db, {
        kind: 'dapta_sync', action: 'early', accountId: fresh, payload: '{}', now,
      });
      await db.run(sql`UPDATE outbox SET status = 'failed' WHERE id = ${id}`);
      expect(await hasDaptaSyncRow(db, fresh, 'early')).toBe(true);
    });

    it('is scoped by account and by action', async () => {
      const other = await makeAccount(now - 1000);
      await enqueueOutbox(db, { kind: 'dapta_sync', action: 'early', accountId: other, payload: '{}', now });
      expect(await hasDaptaSyncRow(db, fresh, 'early')).toBe(false);
      expect(await hasDaptaSyncRow(db, other, 'complete')).toBe(false);
    });

    it('ignores rows of another kind', async () => {
      await enqueueOutbox(db, {
        kind: 'iam_onboarding', action: 'early', accountId: fresh, payload: '{}', now,
      });
      expect(await hasDaptaSyncRow(db, fresh, 'early')).toBe(false);
    });
  });
});
