import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { ServerEnv } from '@slate/config/env';
import { OutboxSkipError } from './email-effects';
import { ENV } from './tokens';

/**
 * O2 growth — the OUTBOUND half (#94, #65). Drained by the outbox worker; never
 * called from a request handler (invariant 5).
 *
 * Two kinds land here, and they are separate rows on purpose:
 *
 *  - `dapta_sync` (`early` / `complete` / `member_invite`) upserts a contact in
 *    DAPTA'S OWN marketing CRM. This is not the customer-facing CRM integration
 *    of #63 — different portal, different product, different constraints.
 *  - `iam_onboarding` (`responses`) posts the qualification answers to the
 *    identity service, which computes the lead score.
 *
 * Keeping them apart is what makes a CRM outage safe: a failing contact upsert
 * retries on its own row and can never re-post the responses, so one workspace
 * can never acquire two lead scores. It is also how "the invite path skips the
 * IAM entirely" holds by construction — that path simply enqueues no
 * `iam_onboarding` row, rather than relying on a branch inside a shared handler.
 *
 * UNSET destination = the row is SKIPPED, not failed. A bare fork must report
 * nothing to Dapta, and recording that once with a reason is honest; burning
 * five retries against a URL that does not exist would fill the delivery log
 * with noise the self-hoster then has to explain to themselves.
 */
/** The contact actions this handler knows. Mirrors `GrowthService`'s enqueues. */
const CONTACT_ACTIONS: ReadonlySet<string> = new Set(['early', 'complete', 'member_invite']);

@Injectable()
export class DaptaSyncEffects {
  private readonly log = new Logger('DaptaSyncEffects');
  /** Injectable for tests; defaults to global fetch, mirroring OutboxWorker. */
  fetchImpl: typeof fetch = fetch;

  constructor(@Optional() @Inject(ENV) private readonly env?: ServerEnv) {}

  /** Contact upsert into Dapta's marketing CRM. */
  async deliverContact(action: string, payload: string | null): Promise<void> {
    if (!CONTACT_ACTIONS.has(action)) {
      // Not a skip: an action nobody handles is a coding fault, and it should
      // be loud in the delivery log rather than filed away as a decision.
      throw new Error(`unknown dapta_sync action: ${action}`);
    }
    if (payload == null) throw new Error('dapta_sync outbox row missing payload');

    // No email means no upsert key, permanently — waiting cannot produce one.
    // Recorded ONCE with a reason rather than dropped at the enqueue site, so
    // an un-upsertable contact is visible in the delivery log instead of being
    // invisible everywhere (#65: members with no email are skipped, not lost).
    const { email } = JSON.parse(payload) as { email?: string | null };
    if (!email) {
      throw new OutboxSkipError('member has no email — not upsertable in the CRM');
    }

    const url = this.env?.DAPTA_SYNC_URL;
    if (!url) {
      throw new OutboxSkipError('DAPTA_SYNC_URL is not configured — growth sync disabled');
    }
    await this.post(url, this.env?.DAPTA_SYNC_TOKEN, payload, `dapta_sync:${action}`);
  }

  /**
   * The lead-score post. Reuses the identity service already configured for
   * O1's cohort probe — one upstream, one pair of env vars, no second host.
   */
  async deliverLeadScore(action: string, payload: string | null): Promise<void> {
    const base = this.env?.ONBOARDING_IAM_BASE_URL;
    if (!base) {
      throw new OutboxSkipError('ONBOARDING_IAM_BASE_URL is not configured — no lead scoring');
    }
    if (payload == null) throw new Error('iam_onboarding outbox row missing payload');
    if (action !== 'responses') throw new Error(`unknown iam_onboarding action: ${action}`);
    await this.post(
      `${base.replace(/\/+$/, '')}/onboarding/responses`,
      this.env?.ONBOARDING_IAM_TOKEN,
      payload,
      'iam_onboarding:responses',
    );
  }

  /**
   * One POST, bounded. A non-2xx THROWS so the worker's normal failure path
   * backs it off and retries — a marketing endpoint returning 503 is exactly
   * the case the outbox exists for.
   */
  private async post(
    url: string,
    token: string | undefined,
    body: string,
    label: string,
  ): Promise<void> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token) headers.authorization = `Bearer ${token}`;

    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(this.env?.DAPTA_SYNC_TIMEOUT_MS ?? 5000),
    });
    if (!res.ok) {
      // The status only. A marketing endpoint's error body can echo the contact
      // details we just sent it, and `last_error` is a durable column.
      throw new Error(`${label} → ${res.status}`);
    }
    this.log.debug(`${label} delivered`);
  }
}
