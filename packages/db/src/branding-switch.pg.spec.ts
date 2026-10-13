import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import { cacheEntitlement } from './short-links';
import { getBrandingSwitch, getBrandingSwitchByCode, setHideBranding } from './branding-switch';

/**
 * The branding switch against a REAL Postgres: migration 0024's column, its
 * default for an account inserted without it, and the BIGINT verdict time read
 * back as a number. Every fixture is created here and unique per run (see
 * onboarding.pg.spec.ts for why a shared database rules out `seed()`).
 * Skipped on the SQLite dev default.
 */
const url = process.env.DATABASE_URL ?? '';
const isPg = url.startsWith('postgres://') || url.startsWith('postgresql://');
const describePg = isPg ? describe : describe.skip;

describePg('account branding switch (real Postgres)', () => {
  let db: Db;

  beforeAll(async () => {
    db = await createDb(url);
    await migrate(db);
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  async function freshAccount(): Promise<{ id: string; code: string }> {
    const id = randomUUID();
    const code = `pgb${id.slice(0, 8)}`;
    await db.run(sql`INSERT INTO account (id, code, name, created_at) VALUES (${id}, ${code}, ${'Fresh Co'}, ${Date.now()})`);
    return { id, code };
  }

  it('an account inserted without the column defaults to branding on', async () => {
    const { id } = await freshAccount();
    expect(await getBrandingSwitch(db, id)).toEqual({
      accountId: id,
      hideBranding: false,
      entitlement: null,
      entitlementCheckedAt: null,
    });
  });

  it('round-trips the choice and the verdict, the time as a number', async () => {
    const { id, code } = await freshAccount();
    await setHideBranding(db, id, true);
    await cacheEntitlement(db, id, 'paid');
    const row = await getBrandingSwitchByCode(db, code);
    expect(row).toMatchObject({ accountId: id, hideBranding: true, entitlement: 'paid' });
    expect(typeof row!.entitlementCheckedAt).toBe('number');
    await setHideBranding(db, id, false);
    expect((await getBrandingSwitch(db, id))!.hideBranding).toBe(false);
  });
});
