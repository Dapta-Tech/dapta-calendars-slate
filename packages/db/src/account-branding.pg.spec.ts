import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import { updateBranding } from './parity';
import { applyBrandKit, getAccountBranding, upsertAccountBranding } from './account-branding';
import { revertBranding } from './brand-backup';

/**
 * The brand kit against a REAL Postgres. The SQLite twin owns the rules; this
 * file covers the jsonb round trip of the kit and of the snapshot, and the
 * account scoping of the apply's UPDATE. Fixtures are unique per run: a
 * Postgres `DATABASE_URL` is a shared database other pg specs seed.
 */
const url = process.env.DATABASE_URL ?? '';
const isPg = url.startsWith('postgres://') || url.startsWith('postgresql://');
const describePg = isPg ? describe : describe.skip;

describePg('workspace brand kit (real Postgres)', () => {
  let db: Db;
  let accountId: string;
  let memberId: string;

  const raw = () =>
    db.get<{ brand_color: string | null; booking_page_style: unknown }>(
      sql`SELECT brand_color, booking_page_style FROM member WHERE id = ${memberId}`,
    );

  beforeAll(async () => {
    db = await createDb(url);
    await migrate(db);
    accountId = randomUUID();
    await db.run(
      sql`INSERT INTO account (id, code, name, created_at)
          VALUES (${accountId}, ${'kt' + accountId.slice(0, 6)}, ${'Kit Co'}, ${Date.now()})`,
    );
    memberId = randomUUID();
    await db.run(
      sql`INSERT INTO member (id, account_id, handle, display_name, time_zone, created_at)
          VALUES (${memberId}, ${accountId}, ${'kit-host'}, ${'Kit Host'}, ${'UTC'}, ${Date.now()})`,
    );
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  it('stores the kit as jsonb, snapshots it, and reverts exactly', async () => {
    await updateBranding(db, memberId, { brandColor: '#cbe84f', style: { template: 'banded', bio: 'Hi.' } });
    const before = await raw();
    const kit = { accent: '#2f6fed', theme: 'light' as const, corners: 'round' as const, logoUrl: 'https://cdn.example.test/l.svg' };
    await upsertAccountBranding(db, accountId, kit);
    expect((await getAccountBranding(db, accountId))!.config).toEqual(kit);
    expect(await applyBrandKit(db, accountId, memberId)).toBe(true);
    expect((await raw())!.booking_page_style).toMatchObject({ template: 'banded', theme: 'light', corners: 'round' });
    await revertBranding(db, memberId);
    expect(await raw()).toEqual(before);
  });
});
