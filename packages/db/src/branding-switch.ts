/**
 * The account's Dapta branding switch and the entitlement verdict it depends on.
 *
 * Two facts on one row, kept apart on purpose:
 *  - `hide_branding` is the account's CHOICE. It survives a lapsed subscription,
 *    so a customer who re-subscribes gets it back without touching anything.
 *  - `dapta_entitlement` / `entitlement_checked_at` is the cached upstream
 *    VERDICT (written by `cacheEntitlement`). Calendars never bills; the
 *    upstream service is the source of truth and this is only its last answer.
 *
 * Whether a page shows the branding is decided from both by
 * `showDaptaBranding` in @slate/shared, never here.
 */
import { sql, type Db } from './client';
import { getAccountByCode } from './repository';

export interface BrandingSwitchRow {
  accountId: string;
  hideBranding: boolean;
  /** 'paid' | 'free', or null when the upstream was never asked. */
  entitlement: 'paid' | 'free' | null;
  /** Epoch ms of the last upstream answer, or null. */
  entitlementCheckedAt: number | null;
}

interface RawRow {
  id: string;
  hide_branding: number | string | null;
  dapta_entitlement: string | null;
  entitlement_checked_at: number | string | null;
}

function toRow(r: RawRow): BrandingSwitchRow {
  return {
    accountId: r.id,
    hideBranding: Number(r.hide_branding) === 1,
    entitlement: r.dapta_entitlement === 'paid' ? 'paid' : r.dapta_entitlement === 'free' ? 'free' : null,
    entitlementCheckedAt: r.entitlement_checked_at == null ? null : Number(r.entitlement_checked_at),
  };
}

/** The account's branding switch and cached verdict, by account id. */
export async function getBrandingSwitch(db: Db, accountId: string): Promise<BrandingSwitchRow | null> {
  const r = await db.get<RawRow>(
    sql`SELECT id, hide_branding, dapta_entitlement, entitlement_checked_at
        FROM account WHERE id = ${accountId} LIMIT 1`,
  );
  return r ? toRow(r) : null;
}

/**
 * The same, by any public code the account answers to (short code, vanity slug
 * or a retired alias), resolved exactly as the public profile resolves it.
 */
export async function getBrandingSwitchByCode(db: Db, accountCode: string): Promise<BrandingSwitchRow | null> {
  const account = await getAccountByCode(db, accountCode);
  return account ? getBrandingSwitch(db, account.id) : null;
}

/** Store the account's choice. Whether it is honoured is the render's call. */
export async function setHideBranding(db: Db, accountId: string, hide: boolean): Promise<void> {
  await db.run(sql`UPDATE account SET hide_branding = ${hide ? 1 : 0} WHERE id = ${accountId}`);
}
