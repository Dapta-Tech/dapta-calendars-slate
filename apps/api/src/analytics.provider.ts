/**
 * Product analytics PORT: where this deployment's own telemetry is delivered.
 *
 * Same open-core split as the other seams:
 *   - OSS default: no provider at all (`createAnalyticsProvider` returns null).
 *     `AnalyticsEffects` then enqueues nothing, so a bare fork makes no request
 *     and writes no row.
 *   - Configured: `PRODUCT_ANALYTICS_PROVIDER=posthog` plus a key selects the
 *     committed PostHog adapter below. A fork adds a vendor by implementing
 *     `AnalyticsProvider` and returning it from the factory; nothing upstream
 *     of the port names a vendor.
 *
 * Delivery only ever runs in the outbox worker, never on a request path.
 */
import type { ServerEnv } from '@slate/config/env';
import { resolveAnalyticsConfig, type AnalyticsConfig, type AnalyticsProps } from '@slate/shared';

/** One event about one person, as the port receives it. */
export interface AnalyticsCapture {
  /** Idempotency key: the same event retried is the same event. */
  uuid: string;
  /** The full wire name, already prefixed (`calendars_...`). */
  event: string;
  /** Who the event is about: a host's email. Never a visitor. */
  distinctId: string;
  /** Epoch ms the event HAPPENED, not when it was delivered. */
  timestamp: number;
  properties: AnalyticsProps;
  /** Person properties to set with the event (email, is_internal). */
  personSet?: AnalyticsProps;
  /** The account group key; null when the event belongs to no account. */
  accountKey: string | null;
}

/** Account (group) properties to set, e.g. the signup source. */
export interface AnalyticsAccountUpdate {
  uuid: string;
  /** The person whose action changed the account, for the vendor's bookkeeping. */
  distinctId: string;
  timestamp: number;
  accountKey: string;
  properties: AnalyticsProps;
}

/**
 * Thrown for a delivery that can never succeed (a rejected event, a revoked
 * key). The worker records the row `skipped` once instead of retrying it.
 * Anything else thrown is transient and retried with backoff.
 */
export class AnalyticsRejectedError extends Error {}

export interface AnalyticsProvider {
  readonly name: string;
  capture(event: AnalyticsCapture): Promise<void>;
  updateAccount(update: AnalyticsAccountUpdate): Promise<void>;
}

/**
 * Give up on a hung vendor quickly. The worker drains one row at a time, so
 * every second spent here is a second a booking email waits behind it.
 */
const REQUEST_TIMEOUT_MS = 3_000;

/**
 * PostHog's public ingestion API: one JSON POST per event to `/capture/`,
 * authorized by the write-only project key in the body. No SDK.
 */
export class PosthogAnalyticsProvider implements AnalyticsProvider {
  readonly name = 'posthog';
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl: typeof fetch = fetch;

  constructor(
    private readonly config: AnalyticsConfig,
    private readonly groupType: string,
  ) {}

  capture(e: AnalyticsCapture): Promise<void> {
    return this.post({
      event: e.event,
      distinct_id: e.distinctId,
      uuid: e.uuid,
      timestamp: new Date(e.timestamp).toISOString(),
      properties: {
        ...e.properties,
        ...(e.personSet ? { $set: e.personSet } : {}),
        ...(e.accountKey ? { $groups: { [this.groupType]: e.accountKey } } : {}),
      },
    });
  }

  updateAccount(u: AnalyticsAccountUpdate): Promise<void> {
    return this.post({
      event: '$groupidentify',
      distinct_id: u.distinctId,
      uuid: u.uuid,
      timestamp: new Date(u.timestamp).toISOString(),
      properties: {
        $group_type: this.groupType,
        $group_key: u.accountKey,
        $group_set: u.properties,
      },
    });
  }

  private async post(body: Record<string, unknown>): Promise<void> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.config.host}/capture/`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ api_key: this.config.key, ...body }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        // A redirect would turn the POST into a GET that can only be refused;
        // a misconfigured host fails as itself instead, and is retried.
        redirect: 'error',
      });
    } catch (err) {
      // Network level (DNS, TLS, timeout): transient.
      throw new Error(`analytics delivery failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.ok) return;
    // 408, 429 and 5xx mean "try again"; any other 4xx is refused the same way forever.
    if (res.status === 408 || res.status === 429 || res.status >= 500) {
      throw new Error(`analytics delivery failed: HTTP ${res.status}`);
    }
    throw new AnalyticsRejectedError(`analytics provider rejected the event: HTTP ${res.status}`);
  }
}

/**
 * The deployment's analytics provider, or null when analytics is off.
 *
 * Off is the answer to every incomplete or unknown setting (see
 * `resolveAnalyticsConfig`), never a boot failure: telemetry must not be able
 * to take the API down.
 */
export function createAnalyticsProvider(
  env: Pick<ServerEnv, 'PRODUCT_ANALYTICS_PROVIDER' | 'PRODUCT_ANALYTICS_KEY' | 'PRODUCT_ANALYTICS_HOST'>,
  groupType: string,
): AnalyticsProvider | null {
  const config = resolveAnalyticsConfig({
    provider: env.PRODUCT_ANALYTICS_PROVIDER,
    key: env.PRODUCT_ANALYTICS_KEY,
    host: env.PRODUCT_ANALYTICS_HOST,
  });
  if (!config) return null;
  return new PosthogAnalyticsProvider(config, groupType);
}
