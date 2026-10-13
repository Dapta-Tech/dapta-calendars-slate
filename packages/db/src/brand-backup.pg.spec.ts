import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import { updateBranding } from './parity';
import { applyLook, getBrandBackupState, revertBranding, snapshotBranding } from './brand-backup';

/**
 * Apply then revert against a REAL Postgres. The SQLite twin
 * (`brand-backup.spec.ts`) owns the rules; this file exists for the place the
 * dialects differ: `booking_page_style` and `brand_backup` are `jsonb` here, so
 * the backup goes in and comes back through a cast, and a NULL style must stay
 * a SQL NULL rather than the JSON value `null`.
 *
 * Every fixture is created by this file and unique per run: a Postgres
 * `DATABASE_URL` is a persistent, shared database other pg specs seed.
 */
const url = process.env.DATABASE_URL ?? '';
const isPg = url.startsWith('postgres://') || url.startsWith('postgresql://');
const describePg = isPg ? describe : describe.skip;

describePg('booking page look: apply and revert (real Postgres)', () => {
  let db: Db;
  let memberId: string;

  const raw = () =>
    db.get<{ brand_color: string | null; booking_page_style: unknown; brand_backup: unknown }>(
      sql`SELECT brand_color, booking_page_style, brand_backup FROM member WHERE id = ${memberId}`,
    );

  beforeAll(async () => {
    db = await createDb(url);
    await migrate(db);
    const accountId = randomUUID();
    await db.run(
      sql`INSERT INTO account (id, code, name, created_at)
          VALUES (${accountId}, ${'bk' + accountId.slice(0, 6)}, ${'Backup Co'}, ${Date.now()})`,
    );
    memberId = randomUUID();
    await db.run(
      sql`INSERT INTO member (id, account_id, handle, display_name, time_zone, created_at)
          VALUES (${memberId}, ${accountId}, ${'backup-host'}, ${'Backup Host'}, ${'UTC'}, ${Date.now()})`,
    );
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  it('returns a stored look exactly, then a never-styled host to NULL', async () => {
    await updateBranding(db, memberId, {
      brandColor: '#2f6fed',
      style: { template: 'banded', slotSelect: 'solid', bio: 'Hi.', landingEnabled: true },
    });
    const before = await raw();

    await snapshotBranding(db, memberId, 'new-look');
    await updateBranding(db, memberId, {
      brandColor: '#1a1a1c',
      style: { template: 'split', theme: 'light', bio: 'Hi.', landingEnabled: true },
    });
    expect((await getBrandBackupState(db, memberId))?.source).toBe('new-look');
    expect(await revertBranding(db, memberId)).toBe(true);
    const after = await raw();
    expect(after!.brand_color).toBe(before!.brand_color);
    expect(after!.booking_page_style).toEqual(before!.booking_page_style);
    expect(after!.brand_backup).toBeNull();

    await db.run(sql`UPDATE member SET brand_color = NULL, booking_page_style = NULL WHERE id = ${memberId}`);
    await snapshotBranding(db, memberId, 'kit');
    await updateBranding(db, memberId, { brandColor: '#1a1a1c', style: { theme: 'light' } });
    await revertBranding(db, memberId);
    const cleared = await raw();
    expect(cleared!.brand_color).toBeNull();
    expect(cleared!.booking_page_style).toBeNull();
  });

  // The review's race: a revert landing between an apply's backup and its
  // write. With the row locked for the whole read-decide-write, whatever order
  // they run in, a live look other than the host's own always has a backup.
  it('never leaves an applied look without its backup when apply and revert race', async () => {
    await db.run(sql`UPDATE member SET brand_color = '#cbe84f', booking_page_style = NULL,
                     brand_backup = NULL, brand_applied_at = NULL WHERE id = ${memberId}`);
    for (let i = 0; i < 20; i++) {
      await Promise.all([
        applyLook(db, memberId, 'new-look', () => ({ brandColor: '#1a1a1c', style: { theme: 'light' } })),
        revertBranding(db, memberId),
      ]);
      const r = await db.get<{ brand_color: string | null; brand_backup: unknown }>(
        sql`SELECT brand_color, brand_backup FROM member WHERE id = ${memberId}`,
      );
      if (r!.brand_color === '#1a1a1c') expect(r!.brand_backup).not.toBeNull();
      await revertBranding(db, memberId);
    }
  });
});
