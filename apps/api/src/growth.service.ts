import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  claimAttribution,
  enqueueOutbox,
  getAccountAttribution,
  hasDaptaSyncRow,
  sql,
  type Db,
  type OnboardingAnswers,
} from '@slate/db';
import { ATTRIBUTION_WINDOW_MS, type Attribution } from '@slate/shared';
import type { AttributionInput, EntryType } from '@slate/types';
import type { HostPrincipal } from './auth.service';
import { DB } from './tokens';

/**
 * O2 growth — the ONE place that decides what the funnel is told (#94, #65).
 *
 * Everything here ENQUEUES. Nothing here calls the CRM or the identity service,
 * and that is invariant 5 rather than a stylistic preference: a marketing
 * outage must never become a product outage, and a first-run wizard must never
 * wait on a webhook. The outbound half lives in `dapta-sync.effects.ts` and is
 * driven by the outbox worker.
 *
 * Three rules from #65 are enforced HERE, at the single site, rather than
 * defended at each caller:
 *
 *  1. `entry_type` is its own field and never touches `lead_source`. The CRM
 *     upsert is by email, so an invitee who is already a contact from an earlier
 *     campaign must keep the better attribution they already have.
 *  2. `lead_source` is emitted only when a real qualification answer exists.
 *     The invite payload does not carry the key at all — not null, not empty. A
 *     field that is absent cannot overwrite.
 *  3. The invite path never enqueues the IAM row. That endpoint computes a lead
 *     score from answers; posting none would mint a garbage score
 *     indistinguishable from a real lead that scored low.
 *
 * KNOWN, and inside what #65 decided: `entry_type` is derived from the call
 * site rather than stored, so an invited ADMIN who later answers the workspace
 * qualification pushes `self_serve` and — the upsert being by email — moves
 * their own contact off `workspace_invite`. Constraint 1 protects `lead_source`
 * specifically, not this marker, and the person really did do both things. If
 * the funnel ever needs first-touch semantics here too, the fix is a stored
 * member-level column, not a new branch at each call site.
 */
@Injectable()
export class GrowthService {
  private readonly log = new Logger('GrowthService');

  constructor(@Optional() @Inject(DB) private readonly db: Db) {}

  /* ---------------------------------------------------------------- claim */

  /**
   * Claim the parked attribution blob onto the caller's account.
   *
   * Both refusals — already claimed, or the account is older than the window —
   * are reported to the caller as a plain `claimed: false`. Neither is an error
   * a user should ever see: a click that arrives second and a click that
   * arrives late are both simply not recorded, and the browser has nothing to
   * do about either.
   *
   * The ten-minute window has ONE definition (`ATTRIBUTION_WINDOW_MS`, beside
   * the parser that produced the blob); the data layer takes the resulting
   * absolute cutoff and carries no policy of its own.
   */
  async claim(p: HostPrincipal, attribution: AttributionInput): Promise<{ claimed: boolean }> {
    const now = Date.now();
    const result = await claimAttribution(this.db, p.accountId, attribution as Attribution, {
      createdAfter: now - ATTRIBUTION_WINDOW_MS,
      now,
    });
    if (!result.claimed) {
      this.log.debug(`attribution not claimed for ${p.accountId}: ${result.reason}`);
    }
    return { claimed: result.claimed };
  }

  /* -------------------------------------------------------------- enqueue */

  /**
   * The wizard's FIRST answer — the contact exists even for someone who types
   * one thing and closes the tab, which is the whole point of firing early
   * (#65 → Growth funnel).
   *
   * At most one per account, ever. The wizard can be re-opened and the trigger
   * fires per session, so without the guard one lead would be pushed again on
   * every visit. No answers ride along: at this moment there is exactly one and
   * it would be a partial description of the workspace.
   */
  async enqueueEarly(p: HostPrincipal): Promise<{ enqueued: boolean }> {
    if (await hasDaptaSyncRow(this.db, p.accountId, 'early')) return { enqueued: false };

    const contact = await this.contactFor(p.accountId, p.memberId);
    if (!contact) return { enqueued: false };

    await enqueueOutbox(this.db, {
      kind: 'dapta_sync',
      action: 'early',
      accountId: p.accountId,
      payload: JSON.stringify({ ...contact, entry_type: 'self_serve' satisfies EntryType }),
    });
    return { enqueued: true };
  }

  /**
   * Qualification was CLAIMED — the workspace described itself, once.
   *
   * Two rows, deliberately separate: the CRM contact and the IAM lead score
   * retry independently, so a CRM outage can never re-post the responses and
   * mint a second score for one workspace. That is also why this is called only
   * on a WON claim: O1 hardened `claimQualification` to report the true winner
   * from an affected-row count precisely because two winners here would be two
   * lead scores.
   */
  async enqueueQualified(p: HostPrincipal, answers: OnboardingAnswers): Promise<void> {
    const contact = await this.contactFor(p.accountId, p.memberId);
    if (!contact) return;

    const attribution = (await getAccountAttribution(this.db, p.accountId)).attribution ?? undefined;

    await enqueueOutbox(this.db, {
      kind: 'dapta_sync',
      action: 'complete',
      accountId: p.accountId,
      payload: JSON.stringify({
        ...contact,
        entry_type: 'self_serve' satisfies EntryType,
        // `lead_source` rides ONLY on this path, because only here does a real
        // qualification answer exist to justify writing it.
        ...(answers.lead_source ? { lead_source: answers.lead_source } : {}),
        answers,
        params: attribution,
      }),
    });

    await enqueueOutbox(this.db, {
      kind: 'iam_onboarding',
      action: 'responses',
      accountId: p.accountId,
      payload: JSON.stringify({ external_id: contact.user_id, email: contact.email, answers }),
    });
  }

  /**
   * A member was INVITED into the workspace.
   *
   * Fires when the membership row is created, not at template pick: an invitee
   * who never finishes setup is exactly the person this exists to capture.
   *
   * `entry_type: workspace_invite` is the whole marker. No `lead_source`, no
   * answers, no attribution, no phone — and no IAM row, so no lead score is
   * minted for someone who answered nothing.
   */
  async enqueueMemberInvite(accountId: string, memberId: string): Promise<{ enqueued: boolean }> {
    const contact = await this.contactFor(accountId, memberId);
    if (!contact) return { enqueued: false };

    await enqueueOutbox(this.db, {
      kind: 'dapta_sync',
      action: 'member_invite',
      accountId,
      payload: JSON.stringify({
        ...contact,
        entry_type: 'workspace_invite' satisfies EntryType,
      }),
    });
    return { enqueued: true };
  }

  /* ------------------------------------------------------------- internal */

  /**
   * The contact half of every payload. `email` is the CRM's upsert key;
   * `user_id` is the upstream identity, which an invitee does not have yet
   * (`external_id` stays NULL until their first login) and which is therefore
   * nullable by construction rather than by accident.
   *
   * Account-scoped (invariant 4).
   */
  private async contactFor(
    accountId: string,
    memberId: string,
  ): Promise<{ email: string | null; user_id: string | null; account_id: string; name: string | null } | null> {
    const row = await this.db.get<{
      email: string | null;
      external_id: string | null;
      display_name: string | null;
    }>(
      sql`SELECT email, external_id, display_name FROM member
           WHERE id = ${memberId} AND account_id = ${accountId} LIMIT 1`,
    );
    if (!row) return null;
    return {
      email: row.email && row.email.length > 0 ? row.email : null,
      user_id: row.external_id && row.external_id.length > 0 ? row.external_id : null,
      account_id: accountId,
      name: row.display_name && row.display_name.length > 0 ? row.display_name : null,
    };
  }
}
