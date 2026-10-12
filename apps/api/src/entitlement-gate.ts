import { Logger } from '@nestjs/common';
import { cacheEntitlement, getBrandingSwitch, sql, type BrandingSwitchRow, type Db } from '@slate/db';
import { entitlementIsStale, showDaptaBranding, type PremiumMode } from '@slate/shared';
import type { EntitlementsProvider } from './entitlements.provider';

/**
 * The cached Dapta AI entitlement verdict, read two ways.
 *
 * Calendars never charges: premium switches (the vanity link, hiding the Dapta
 * branding) come with a PAYING Dapta AI subscription, which the upstream
 * service decides. Its answer is cached on the account row for
 * `ENTITLEMENT_TTL_MS` (6 h), and the gate reads that cache two ways:
 *
 *  - `isEntitled` (settings, authenticated): refreshes a stale verdict INLINE
 *    before answering, so a host who just subscribed sees the switch unlock.
 *  - `showBranding` (every public page, anonymous): decides from the cache AS
 *    IT STANDS and never waits on the upstream. When the account has asked to
 *    hide the branding and the verdict is stale, it starts a refresh on the
 *    side and returns at once. The first public view more than one TTL after
 *    the last check queues the refresh; every view after it lands renders with
 *    the new verdict. So a lapsed subscription shows the branding again at most
 *    one TTL after the last check that still read `paid`, plus the time to the
 *    next visit. A page nobody visits shows nothing to anyone.
 *
 * One refresh per account at a time (`inflight`), so a burst of visits makes
 * one upstream call. A failed refresh is the provider's `false`, cached like
 * any answer, which errs toward showing the branding.
 */
export class EntitlementGate {
  private readonly log = new Logger('Entitlements');
  private readonly inflight = new Map<string, Promise<boolean>>();

  constructor(
    private readonly db: Db,
    private readonly provider: EntitlementsProvider,
    private readonly premiumMode: PremiumMode,
    private readonly now: () => number = Date.now,
  ) {}

  /** Settings path: the verdict, refreshed inline when older than the TTL. */
  async isEntitled(accountId: string): Promise<boolean> {
    if (this.premiumMode === 'open') return true;
    const row = await getBrandingSwitch(this.db, accountId);
    if (!row) return false;
    if (!entitlementIsStale(row.entitlementCheckedAt, this.now()) || !this.provider.enabled) {
      return row.entitlement === 'paid';
    }
    return this.refresh(row);
  }

  /** Public path: does this account's page carry the Dapta branding? Never blocks upstream. */
  async showBranding(accountId: string | null | undefined): Promise<boolean> {
    if (!accountId) return true;
    const row = await getBrandingSwitch(this.db, accountId);
    return this.showBrandingFor(row);
  }

  /** The same, for a row the caller already holds. */
  showBrandingFor(row: BrandingSwitchRow | null): boolean {
    if (!row) return true;
    // Only an account that asked to hide the branding has a verdict worth
    // keeping fresh from the public side; everyone else shows it regardless.
    if (
      row.hideBranding &&
      this.premiumMode === 'locked' &&
      this.provider.enabled &&
      entitlementIsStale(row.entitlementCheckedAt, this.now())
    ) {
      void this.refresh(row).catch(() => undefined);
    }
    return showDaptaBranding({
      hideBranding: row.hideBranding,
      entitlement: row.entitlement,
      premiumMode: this.premiumMode,
    });
  }

  /** Ask the upstream once per account at a time, cache the answer, log a flip. */
  private refresh(row: BrandingSwitchRow): Promise<boolean> {
    const running = this.inflight.get(row.accountId);
    if (running) return running;
    const job = (async () => {
      const acc = await this.db.get<{ external_id: string | null }>(
        sql`SELECT external_id FROM account WHERE id = ${row.accountId} LIMIT 1`,
      );
      // Keyed by the account owner's email (the upstream resolves customers by
      // owner email) plus the org id.
      const owner = await this.db.get<{ email: string | null }>(
        sql`SELECT email FROM member
            WHERE account_id = ${row.accountId} AND role = 'owner' AND status = 'active'
            ORDER BY created_at ASC LIMIT 1`,
      );
      const paid = await this.provider.isPaidCustomer({
        ownerEmail: owner?.email,
        externalOrgId: acc?.external_id ?? null,
      });
      const verdict = paid ? 'paid' : 'free';
      await cacheEntitlement(this.db, row.accountId, verdict);
      if (row.entitlement && row.entitlement !== verdict) {
        // The account id only: never the owner's email.
        this.log.log(`entitlement verdict flipped ${row.entitlement} -> ${verdict} account=${row.accountId}`);
      }
      return paid;
    })().finally(() => this.inflight.delete(row.accountId));
    this.inflight.set(row.accountId, job);
    return job;
  }
}
