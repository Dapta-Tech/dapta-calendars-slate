/**
 * The workspace brand kit's storage, and "Apply kit" for one host's page.
 *
 * The kit lives in `account_branding` (one row per account). A host's page
 * never reads it: `applyBrandKit` SNAPSHOTS it into the member's own stored
 * branding, after keeping what was stored as a one-step backup
 * (`snapshotBranding`, source `kit`), so "Revert" works once and a later edit
 * of the kit never moves a live page. Team pages store no branding of their
 * own and read the kit through `getTeamProfile`.
 */
import { withBrandKit, hasBrandKit, type BrandKit } from '@slate/types';
import { sql, type Db } from './client';
import { jsonParam, parseJsonColumn } from './repository';
import { applyLook } from './brand-backup';

export interface AccountBrandingRow {
  accountId: string;
  config: BrandKit;
  createdAt: number;
  updatedAt: number;
}

export async function getAccountBranding(db: Db, accountId: string): Promise<AccountBrandingRow | null> {
  const r = await db.get<{ account_id: string; config: unknown; created_at: number | string; updated_at: number | string }>(
    sql`SELECT account_id, config, created_at, updated_at FROM account_branding
        WHERE account_id = ${accountId} LIMIT 1`,
  );
  if (!r) return null;
  return {
    accountId: String(r.account_id),
    config: parseJsonColumn<BrandKit>(r.config, {}),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

/** Create or replace the account's kit. Returns the stored row. */
export async function upsertAccountBranding(
  db: Db,
  accountId: string,
  config: BrandKit,
): Promise<AccountBrandingRow> {
  const now = Date.now();
  const existing = await getAccountBranding(db, accountId);
  if (existing) {
    await db.run(
      sql`UPDATE account_branding SET config = ${jsonParam(db, config)}, updated_at = ${now}
          WHERE account_id = ${accountId}`,
    );
  } else {
    await db.run(
      sql`INSERT INTO account_branding (account_id, config, created_at, updated_at)
          VALUES (${accountId}, ${jsonParam(db, config)}, ${now}, ${now})`,
    );
  }
  return (await getAccountBranding(db, accountId))!;
}

/**
 * Snapshot the account's kit into one member's branding. Returns false when the
 * account has no kit (or an empty one), in which case nothing is written.
 * Scoped by account: a member of another account is never touched.
 */
export async function applyBrandKit(db: Db, accountId: string, memberId: string): Promise<boolean> {
  const kit = (await getAccountBranding(db, accountId))?.config;
  if (!hasBrandKit(kit)) return false;
  const row = await db.get<{ brand_color: string | null; booking_page_style: unknown }>(
    sql`SELECT brand_color, booking_page_style FROM member
        WHERE id = ${memberId} AND account_id = ${accountId} LIMIT 1`,
  );
  if (!row) return false;
  // The merge is computed from the row as read under the lock, and the backup
  // and the write land in one transaction (`applyLook`), so a concurrent
  // revert or studio save cannot split them.
  return applyLook(db, memberId, 'kit', (current) => {
    const next = withBrandKit(current, kit);
    // A kit that sets only the accent leaves a never-styled page's style NULL.
    return next.style ? { brandColor: next.brandColor, style: next.style } : { brandColor: next.brandColor };
  });
}
