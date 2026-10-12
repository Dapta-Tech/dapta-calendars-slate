import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import { seed } from './seed';
import { getAccountByCode, getMember } from './repository';
import { updateBranding } from './parity';
import { getBrandBackupState, revertBranding, snapshotBranding } from './brand-backup';

/**
 * Apply a look, then revert it: the stored branding comes back byte for byte.
 *
 * The backup exists so a host can try a look (the studio's "new look", or the
 * workspace brand kit) on their LIVE page and take it back. The promise is the
 * stored value itself, not "something similar": these read the raw columns.
 */
describe('booking page look: apply and revert (SQLite in-memory)', () => {
  let db: Db;
  let memberId: string;

  const raw = () =>
    db.get<{ brand_color: string | null; booking_page_style: string | null; brand_backup: string | null }>(
      sql`SELECT brand_color, booking_page_style, brand_backup FROM member WHERE id = ${memberId}`,
    );

  const NEW_LOOK = {
    brandColor: '#1a1a1c',
    style: {
      template: 'split',
      cardStyle: 'outline',
      corners: 'sharp',
      buttons: 'square',
      density: 'compact',
      font: 'sans',
      slotLayout: 'list',
      dayGroup: 'flat',
      slotSelect: 'soft',
      theme: 'light',
      bio: 'Book a time with me.',
      landingEnabled: true,
    },
  };

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    const account = await getAccountByCode(db, 'acme');
    memberId = (await getMember(db, account!.id, 'alex-rivera'))!.id;
  });

  it('has nothing to revert for a host who never applied a look', async () => {
    expect(await getBrandBackupState(db, memberId)).toBeNull();
    expect(await revertBranding(db, memberId)).toBe(false);
  });

  it('returns the stored branding byte for byte', async () => {
    const before = await raw();
    await snapshotBranding(db, memberId, 'new-look');
    await updateBranding(db, memberId, NEW_LOOK);
    expect((await raw())!.brand_color).toBe('#1a1a1c');
    const state = await getBrandBackupState(db, memberId);
    expect(state?.source).toBe('new-look');
    expect(state?.appliedAt).toBeGreaterThan(0);

    expect(await revertBranding(db, memberId)).toBe(true);
    const after = await raw();
    expect(after!.brand_color).toBe(before!.brand_color);
    expect(after!.booking_page_style).toBe(before!.booking_page_style);
    expect(after!.brand_backup).toBeNull();
    expect(await getBrandBackupState(db, memberId)).toBeNull();
  });

  it('reverts a host who had stored nothing back to nothing', async () => {
    await db.run(sql`UPDATE member SET brand_color = NULL, booking_page_style = NULL WHERE id = ${memberId}`);
    await snapshotBranding(db, memberId, 'new-look');
    await updateBranding(db, memberId, NEW_LOOK);
    await revertBranding(db, memberId);
    const after = await raw();
    expect(after!.brand_color).toBeNull();
    // The content the host wrote after the apply (bio, landing switch) stays.
    expect(JSON.parse(after!.booking_page_style!)).toEqual({ bio: 'Book a time with me.', landingEnabled: true });
  });

  it('keeps the first backup when a second look lands before a revert', async () => {
    const before = await raw();
    await snapshotBranding(db, memberId, 'new-look');
    await updateBranding(db, memberId, NEW_LOOK);
    await snapshotBranding(db, memberId, 'kit');
    await updateBranding(db, memberId, { brandColor: '#2f6fed' });
    expect((await getBrandBackupState(db, memberId))?.source).toBe('kit');
    await revertBranding(db, memberId);
    const after = await raw();
    expect(after!.brand_color).toBe(before!.brand_color);
    expect(after!.booking_page_style).toBe(before!.booking_page_style);
  });

  it('restores the look and keeps content edited after the apply', async () => {
    await snapshotBranding(db, memberId, 'new-look');
    await updateBranding(db, memberId, { ...NEW_LOOK, style: { ...NEW_LOOK.style, bio: 'New words.' } });
    await revertBranding(db, memberId);
    const style = JSON.parse((await raw())!.booking_page_style!);
    expect(style.template).toBe('classic');
    expect(style.theme).toBeUndefined();
    expect(style.bio).toBe('New words.');
  });
});
