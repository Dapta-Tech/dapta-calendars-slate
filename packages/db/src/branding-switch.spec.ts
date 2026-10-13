import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import { seed } from './seed';
import { cacheEntitlement } from './short-links';
import { getBrandingSwitch, getBrandingSwitchByCode, setHideBranding } from './branding-switch';

describe('account branding switch (SQLite)', () => {
  let db: Db;
  let accountId: string;
  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    accountId = (await db.get<{ id: string }>(sql`SELECT id FROM account WHERE code='acme'`))!.id;
  });

  it('defaults to branding on, with no verdict', async () => {
    expect(await getBrandingSwitch(db, accountId)).toEqual({
      accountId,
      hideBranding: false,
      entitlement: null,
      entitlementCheckedAt: null,
    });
  });

  it('stores the choice apart from the verdict, and keeps it when the verdict changes', async () => {
    await setHideBranding(db, accountId, true);
    await cacheEntitlement(db, accountId, 'paid');
    expect(await getBrandingSwitch(db, accountId)).toMatchObject({ hideBranding: true, entitlement: 'paid' });
    await cacheEntitlement(db, accountId, 'free');
    expect(await getBrandingSwitch(db, accountId)).toMatchObject({ hideBranding: true, entitlement: 'free' });
    await setHideBranding(db, accountId, false);
    expect((await getBrandingSwitch(db, accountId))!.hideBranding).toBe(false);
  });

  it('resolves by any public code the account answers to, and by nothing else', async () => {
    await setHideBranding(db, accountId, true);
    expect((await getBrandingSwitchByCode(db, 'acme'))!.hideBranding).toBe(true);
    expect((await getBrandingSwitchByCode(db, 'ACME'))!.accountId).toBe(accountId);
    expect(await getBrandingSwitchByCode(db, 'nobody-here')).toBeNull();
    expect(await getBrandingSwitch(db, 'no-such-id')).toBeNull();
  });
});
