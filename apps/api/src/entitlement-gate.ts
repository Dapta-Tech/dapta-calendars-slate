import { Logger } from '@nestjs/common';
import { cacheEntitlement, getBrandingSwitch, sql, type BrandingSwitchRow, type Db } from '@slate/db';
import { entitlementIsStale, showDaptaBranding, type PremiumMode } from '@slate/shared';
import type { EntitlementsProvider } from './entitlements.provider';
import { DB, ENTITLEMENT_GATE, ENTITLEMENTS, PREMIUM_MODE } from './tokens';

/** The first wait after an upstream that could not answer; it doubles per failure. */
export const ENTITLEMENT_FAILURE_BACKOFF_MS = 60_000;
/** The longest wait between two tries while the upstream keeps failing. */
export const ENTITLEMENT_FAILURE_BACKOFF_MAX_MS = 30 * 60_000;

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
 * one upstream call. The app registers ONE gate (`ENTITLEMENT_GATE`) and every
 * service shares it, so that rule holds across the public pages, the emails and
 * Settings.
 *
 * When the upstream cannot answer (`unknown`: a timeout, a 5xx), nothing is
 * cached and nothing flips: the previous verdict stands, so a paying host keeps
 * the branding off and Settings never says their subscription ended. The gate
 * asks again after a short backoff (1 min, doubling, at most 30 min) instead of
 * on every visit. A provider that THROWS breaks its contract: the same backoff
 * applies, the public pages show the branding until an answer lands (fail
 * closed), and Settings still answers.
 */
export class EntitlementGate {
  private readonly log = new Logger('Entitlements');
  private readonly inflight = new Map<string, Promise<'paid' | 'free' | null>>();
  /** Accounts whose last ask failed: when to ask again, and whether it threw. */
  private readonly failures = new Map<string, { count: number; retryAt: number; threw: boolean }>();

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
    if (!this.shouldAsk(row)) return row.entitlement === 'paid';
    return (await this.refresh(row)) === 'paid';
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
    if (row.hideBranding && this.premiumMode === 'locked' && this.shouldAsk(row)) {
      void this.refresh(row).catch(() => undefined);
    }
    // A provider that threw: show the branding until an answer lands.
    if (row.hideBranding && this.premiumMode === 'locked' && this.failures.get(row.accountId)?.threw) return true;
    return showDaptaBranding({
      hideBranding: row.hideBranding,
      entitlement: row.entitlement,
      premiumMode: this.premiumMode,
    });
  }

  /** Is the cached verdict worth asking about now: stale, wired, and not backing off? */
  private shouldAsk(row: BrandingSwitchRow): boolean {
    if (!this.provider.enabled || !entitlementIsStale(row.entitlementCheckedAt, this.now())) return false;
    const failed = this.failures.get(row.accountId);
    return !failed || this.now() >= failed.retryAt;
  }

  /**
   * Ask the upstream once per account at a time, cache the answer, log a flip.
   * Resolves to the verdict that now stands: the new one, or, when the
   * upstream fails or throws, the one already cached. Only a database error
   * rejects.
   */
  private refresh(row: BrandingSwitchRow): Promise<'paid' | 'free' | null> {
    const running = this.inflight.get(row.accountId);
    if (running) return running;
    const job = this.ask(row).finally(() => this.inflight.delete(row.accountId));
    this.inflight.set(row.accountId, job);
    return job;
  }

  private async ask(row: BrandingSwitchRow): Promise<'paid' | 'free' | null> {
    let answer: 'paid' | 'free' | 'unknown';
    let threw = false;
    try {
      answer = await this.verdictFor(row.accountId);
    } catch {
      answer = 'unknown';
      threw = true;
    }
    if (answer === 'unknown') {
      const count = (this.failures.get(row.accountId)?.count ?? 0) + 1;
      const wait = Math.min(ENTITLEMENT_FAILURE_BACKOFF_MS * 2 ** (count - 1), ENTITLEMENT_FAILURE_BACKOFF_MAX_MS);
      this.failures.set(row.accountId, { count, retryAt: this.now() + wait, threw });
      // The account id only: never the owner's email, never the error text.
      this.log.warn(
        `entitlement check ${threw ? 'threw' : 'could not answer'}, keeping ${row.entitlement ?? 'no verdict'}, retry in ${Math.round(wait / 1000)}s account=${row.accountId}`,
      );
      return row.entitlement;
    }
    this.failures.delete(row.accountId);
    await cacheEntitlement(this.db, row.accountId, answer);
    if (row.entitlement && row.entitlement !== answer) {
      // The account id only: never the owner's email.
      this.log.log(`entitlement verdict flipped ${row.entitlement} -> ${answer} account=${row.accountId}`);
    }
    return answer;
  }

  /** The upstream's answer for one account, keyed as the upstream resolves customers. */
  private async verdictFor(accountId: string): Promise<'paid' | 'free' | 'unknown'> {
    const acc = await this.db.get<{ external_id: string | null }>(
      sql`SELECT external_id FROM account WHERE id = ${accountId} LIMIT 1`,
    );
    // Keyed by the account owner's email (the upstream resolves customers by
    // owner email) plus the org id.
    const owner = await this.db.get<{ email: string | null }>(
      sql`SELECT email FROM member
          WHERE account_id = ${accountId} AND role = 'owner' AND status = 'active'
          ORDER BY created_at ASC LIMIT 1`,
    );
    return this.provider.verdict({ ownerEmail: owner?.email, externalOrgId: acc?.external_id ?? null });
  }
}

/** The app registers exactly one gate; every service injects it (`ENTITLEMENT_GATE`). */
export const entitlementGateProvider = {
  provide: ENTITLEMENT_GATE,
  useFactory: (db: Db, provider: EntitlementsProvider, premiumMode: PremiumMode) =>
    new EntitlementGate(db, provider, premiumMode),
  inject: [DB, ENTITLEMENTS, PREMIUM_MODE],
};
