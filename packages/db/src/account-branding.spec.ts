import { describe, it, expect, beforeEach } from 'vitest';
import { createDb, sql, type Db } from './client';
import { migrate } from './migrate';
import { seed } from './seed';
import { getAccountByCode, getMember } from './repository';
import { getTeamProfile } from './parity';
import { applyBrandKit, getAccountBranding, upsertAccountBranding } from './account-branding';
import { getBrandBackupState, revertBranding } from './brand-backup';

/**
 * The workspace brand kit: stored per account, SNAPSHOTTED into a host's page
 * on "Apply kit" (never read live), revertible once, rendered directly by team
 * pages. The promises are about stored values, so these read the raw columns.
 */
describe('workspace brand kit (SQLite in-memory)', () => {
  let db: Db;
  let accountId: string;
  let memberId: string;

  const KIT = {
    logoUrl: 'https://cdn.example.test/northwind.svg',
    accent: '#2f6fed',
    theme: 'light' as const,
    font: 'serif' as const,
    corners: 'round' as const,
    buttons: 'pill' as const,
    cardStyle: 'filled' as const,
  };

  const raw = () =>
    db.get<{ brand_color: string | null; booking_page_style: string | null }>(
      sql`SELECT brand_color, booking_page_style FROM member WHERE id = ${memberId}`,
    );

  beforeEach(async () => {
    db = await createDb('file::memory:');
    await migrate(db);
    await seed(db);
    accountId = (await getAccountByCode(db, 'acme'))!.id;
    memberId = (await getMember(db, accountId, 'alex-rivera'))!.id;
  });

  it('stores one kit per account and replaces it on save', async () => {
    expect(await getAccountBranding(db, accountId)).toBeNull();
    await upsertAccountBranding(db, accountId, { accent: '#111111' });
    const row = await upsertAccountBranding(db, accountId, KIT);
    expect(row.config).toEqual(KIT);
    expect(row.updatedAt).toBeGreaterThanOrEqual(row.createdAt);
  });

  it('applies nothing, and keeps no backup, when there is no kit', async () => {
    const before = await raw();
    expect(await applyBrandKit(db, accountId, memberId)).toBe(false);
    await upsertAccountBranding(db, accountId, {});
    expect(await applyBrandKit(db, accountId, memberId)).toBe(false);
    expect(await raw()).toEqual(before);
    expect(await getBrandBackupState(db, memberId)).toBeNull();
  });

  it('snapshots the kit into the host page, keeping their own axes and content', async () => {
    await upsertAccountBranding(db, accountId, KIT);
    expect(await applyBrandKit(db, accountId, memberId)).toBe(true);
    const after = await raw();
    expect(after!.brand_color).toBe('#2f6fed');
    const style = JSON.parse(after!.booking_page_style!);
    expect(style).toMatchObject({ theme: 'light', font: 'serif', corners: 'round', buttons: 'pill', cardStyle: 'filled' });
    expect(style.logoUrl).toBe(KIT.logoUrl);
    // What the kit does not decide stays the host's.
    expect(style.template).toBe('classic');
    expect(style.slotLayout).toBe('grid');
    expect(style.bio).toBe('Book a time with me.');
    expect((await getBrandBackupState(db, memberId))?.source).toBe('kit');

    // A kit edit afterwards does not move the page: it was a snapshot.
    await upsertAccountBranding(db, accountId, { ...KIT, accent: '#ff0000' });
    expect((await raw())!.brand_color).toBe('#2f6fed');
  });

  it('apply then revert returns the stored branding byte for byte', async () => {
    const before = await raw();
    await upsertAccountBranding(db, accountId, KIT);
    await applyBrandKit(db, accountId, memberId);
    expect(await revertBranding(db, memberId)).toBe(true);
    expect(await raw()).toEqual(before);
  });

  it('never touches a member of another account', async () => {
    await upsertAccountBranding(db, 'some-other-account', KIT);
    const before = await raw();
    expect(await applyBrandKit(db, 'some-other-account', memberId)).toBe(false);
    expect(await raw()).toEqual(before);
  });

  it('is carried by the team profile, which renders it directly', async () => {
    const team = await db.get<{ slug: string }>(sql`SELECT slug FROM team WHERE account_id = ${accountId} LIMIT 1`);
    const without = await getTeamProfile(db, 'acme', team!.slug);
    expect(without!.brand).toBeNull();
    await upsertAccountBranding(db, accountId, KIT);
    const withKit = await getTeamProfile(db, 'acme', team!.slug);
    expect(withKit!.brand).toEqual(KIT);
  });
});
