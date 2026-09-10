import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { ServerEnv } from '@slate/config/env';
import { CrmAuthError, type CrmProperty, type CrmProvider } from '@slate/crm';
import {
  loadEncryptionKey,
  recordIntegrationHealth,
  resolveProviderToken,
  type Db,
} from '@slate/db';
import {
  CRM_IDENTITY_PROPERTIES,
  type CrmPropertyCatalog,
  type CrmPropertyView,
} from '@slate/types';
import { CRM, DB, ENV } from './tokens';

/**
 * The account's CRM contact-property list, cached (H2 / #108).
 *
 * Two callers with the same need: the mapping picker in the event-type editor,
 * and DELIVERY, which has to know a target's type to coerce a value onto it.
 * Sharing one cache is what keeps the second one from costing a vendor call per
 * booking — a busy account drains its whole outbox off a single fetch.
 *
 * Why fetch at delivery at all, rather than snapshotting each target's type
 * into the stored mapping: a snapshot goes stale silently the moment somebody
 * edits the property in the portal, and the failure that produces is a 400 on a
 * booking write nobody is watching. Reading the live schema every five minutes
 * is the cheaper half of that trade.
 *
 * The cache is per PROCESS. In a multi-instance deployment each instance warms
 * its own; with a five-minute TTL and an explicit Refresh that is a rounding
 * error, and it is why this is a plain Map rather than a shared store.
 */
const TTL_MS = 5 * 60_000;

interface CacheEntry {
  properties: CrmPropertyView[];
  fetchedAt: number;
}

@Injectable()
export class CrmPropertyCatalogService {
  private readonly log = new Logger('CrmPropertyCatalog');
  private readonly cache = new Map<string, CacheEntry>();
  /**
   * In-flight fetches, keyed by account. Refresh bypasses the TTL but NOT this:
   * a host leaning on the Refresh button, or a burst of outbox rows for the
   * same account, must not fan out onto the vendor's rate limit.
   */
  private readonly inFlight = new Map<string, Promise<CrmPropertyView[]>>();

  constructor(
    @Inject(CRM) private readonly crm: CrmProvider,
    @Inject(DB) private readonly db: Db,
    @Optional() @Inject(ENV) private readonly env?: ServerEnv,
  ) {}

  /**
   * The picker's answer. Degrades to an empty list plus a REASON rather than
   * throwing, mirroring `integrationCapabilities`: withholding the picker is
   * the safe direction, offering one that cannot work is not.
   */
  async catalog(accountId: string, opts: { refresh?: boolean } = {}): Promise<CrmPropertyCatalog> {
    if (!this.crm.enabled) {
      return { provider: null, connected: false, properties: [], fetchedAt: null, reason: 'disabled' };
    }
    const credential = await this.credential(accountId);
    if (!credential) {
      return {
        provider: this.crm.name,
        connected: false,
        properties: [],
        fetchedAt: null,
        reason: 'not_connected',
      };
    }

    const cached = this.cache.get(accountId);
    if (!opts.refresh && cached && Date.now() - cached.fetchedAt < TTL_MS) {
      return {
        provider: this.crm.name,
        connected: true,
        properties: cached.properties,
        fetchedAt: cached.fetchedAt,
        reason: null,
      };
    }

    try {
      const properties = await this.fetch(accountId, credential.token);
      return {
        provider: this.crm.name,
        connected: true,
        properties,
        fetchedAt: this.cache.get(accountId)?.fetchedAt ?? Date.now(),
        reason: null,
      };
    } catch (err) {
      if (err instanceof CrmAuthError && credential.integrationId) {
        // Same treatment the write path gives a 401/403: the integration goes
        // unhealthy carrying the structured scope list, so the Integrations tab
        // can name the checkbox that was missed instead of the editor showing a
        // shrug. Never auto-disabled — fixing the scope is enough.
        await recordIntegrationHealth(this.db, {
          integrationId: credential.integrationId,
          ok: false,
          detail: err.message,
          errorDetail: {
            category: err.category,
            requiredGranularScopes: err.requiredGranularScopes,
          },
        }).catch(() => {
          /* health is bookkeeping; it must not turn a degraded read into a 500 */
        });
      }
      this.log.warn(`could not read ${this.crm.name} contact properties: ${String(err)}`);
      // A STALE list beats no list: the host can still see and keep their
      // existing mappings, and Refresh is right there. `fetchedAt` is what tells
      // them how old it is.
      if (cached) {
        return {
          provider: this.crm.name,
          connected: true,
          properties: cached.properties,
          fetchedAt: cached.fetchedAt,
          reason: 'unavailable',
        };
      }
      return {
        provider: this.crm.name,
        connected: true,
        properties: [],
        fetchedAt: null,
        reason: 'unavailable',
      };
    }
  }

  /**
   * Delivery's view: the property list, or an empty array when anything at all
   * is wrong. Mapped properties are BEST-EFFORT — losing a meeting because a
   * property list 500'd is the worse failure, and a mapped value is already
   * omitted on an enumeration mismatch and stripped on an unknown property. The
   * booking still lands; the warning says why the properties did not.
   */
  async propertiesForDelivery(accountId: string, token: string): Promise<CrmPropertyView[]> {
    const cached = this.cache.get(accountId);
    if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached.properties;
    try {
      return await this.fetch(accountId, token);
    } catch (err) {
      this.log.warn(
        `delivering without mapped properties for account ${accountId}: could not read the property list (${String(err)})`,
      );
      return cached?.properties ?? [];
    }
  }

  /** Drop an account's cached list — used when a credential is disconnected. */
  invalidate(accountId: string): void {
    this.cache.delete(accountId);
  }

  /** One fetch per account at a time, cached on success. */
  private fetch(accountId: string, token: string): Promise<CrmPropertyView[]> {
    const existing = this.inFlight.get(accountId);
    if (existing) return existing;
    const run = (async () => {
      const raw = await this.crm.listContactProperties({ token });
      const properties = offerable(raw);
      this.cache.set(accountId, { properties, fetchedAt: Date.now() });
      return properties;
    })().finally(() => this.inFlight.delete(accountId));
    this.inFlight.set(accountId, run);
    return run;
  }

  /** The account's token, or null when nothing is connected. Never returned out. */
  private async credential(
    accountId: string,
  ): Promise<{ token: string; integrationId: string | null } | null> {
    try {
      const key = this.env?.INTEGRATION_ENCRYPTION_KEY
        ? loadEncryptionKey(this.env.INTEGRATION_ENCRYPTION_KEY)
        : null;
      return await resolveProviderToken(
        this.db,
        accountId,
        this.crm.name,
        key,
        this.env?.HUBSPOT_PRIVATE_APP_TOKEN,
      );
    } catch (err) {
      // A stored credential that cannot be opened is a deployment fault. From
      // the picker's point of view it is indistinguishable from not connected,
      // and saying so is more useful than a stack trace in a dropdown.
      this.log.warn(`could not resolve the ${this.crm.name} credential: ${String(err)}`);
      return null;
    }
  }
}

/**
 * THE offerability rule, in one place (#64).
 *
 * Excluded in every case: archived, calculated, hidden, and read-only-value
 * properties — a write to any of them either fails or silently does nothing —
 * plus the three identity properties, which are never mappable because a
 * booking must not rename a contact the CRM already knows (ADR 0005).
 *
 * Unusable properties are ABSENT rather than present-and-disabled: a picker row
 * a host cannot choose is a question they have to answer for themselves.
 */
function offerable(properties: readonly CrmProperty[]): CrmPropertyView[] {
  const identity = new Set<string>(CRM_IDENTITY_PROPERTIES);
  return properties
    .filter(
      (p) =>
        !p.archived &&
        !p.calculated &&
        !p.hidden &&
        !p.readOnlyValue &&
        !identity.has(p.name.toLowerCase()),
    )
    .map((p) => ({
      name: p.name,
      label: p.label,
      type: p.type,
      fieldType: p.fieldType,
      options: p.options,
    }));
}
