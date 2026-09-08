import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Db } from '@slate/db';
import {
  claimQualification,
  createEventType,
  getMe,
  getOnboardingGates,
  sql,
  type OnboardingAnswers,
} from '@slate/db';
import {
  ONBOARDING_TEMPLATES,
  cohortQuestionKeys,
  getOnboardingTemplate,
  resolveCohort,
  type CohortProbeResult,
  type OnboardingCohort,
  type OnboardingTemplate,
} from '@slate/engine';
import { getMessages } from '@slate/shared';
import type {
  OnboardingQualificationInput,
  OnboardingSetupInput,
  OnboardingState,
  OnboardingTemplateView,
} from '@slate/types';
import type { ServerEnv } from '@slate/config/env';
import type { HostPrincipal } from './auth.service';
import { DB, ENV } from './tokens';

/**
 * Onboarding's two gates (ADR 0002). The API is the SINGLE authority on whether
 * a gate is owed — the web app never derives one from an empty event-type list,
 * because deriving it client-side is what produces the redirect loops and
 * first-paint flicker this shape exists to avoid (#65 → Routing and authority).
 *
 * Nothing here writes to the growth CRM. Attribution, the `dapta_sync` outbox
 * row and `entry_type` for invited members are unit O2, and the IAM lead-score
 * write rides that same outbox rather than firing inline from a request handler
 * (invariant 5).
 */
@Injectable()
export class OnboardingService {
  constructor(
    @Inject(DB) private readonly db: Db,
    // Optional so specs can construct this service directly, mirroring
    // AdminService. With no env there is no upstream, so the probe reports
    // `not_configured` and a bare fork answers the full question bank.
    @Optional() @Inject(ENV) private readonly env?: ServerEnv,
  ) {}

  /**
   * Ask the upstream identity service whether it already knows this human.
   *
   * Every failure mode collapses to `error`, because the response to all of
   * them is identical: fail closed to the cohort that asks LESS. The caller
   * must never see a distinction it would be tempted to branch on.
   */
  private async probeCohort(externalId: string | null): Promise<CohortProbeResult> {
    const base = this.env?.ONBOARDING_IAM_BASE_URL;
    // No upstream, or no upstream identity to ask about (a seeded/local member):
    // there is no lead funnel to protect, so answer the full bank.
    if (!base || !externalId) return { outcome: 'not_configured' };

    try {
      const res = await fetch(
        `${base.replace(/\/+$/, '')}/onboarding/status/${encodeURIComponent(externalId)}`,
        {
          headers: this.env?.ONBOARDING_IAM_TOKEN
            ? { authorization: `Bearer ${this.env.ONBOARDING_IAM_TOKEN}` }
            : {},
          signal: AbortSignal.timeout(this.env?.ONBOARDING_PROBE_TIMEOUT_MS ?? 1500),
        },
      );
      if (res.ok) return { outcome: 'known' };
      // Only a definitive "no such identity" widens the interrogation. A 500 or
      // a 401 is an upstream fault, not evidence that this person is a stranger.
      if (res.status === 404) return { outcome: 'unknown' };
      return { outcome: 'error' };
    } catch {
      return { outcome: 'error' };
    }
  }

  private async localeFor(p: HostPrincipal): Promise<string> {
    const me = await getMe(this.db, p.accountId, p.memberId);
    return me?.locale ?? 'en';
  }

  private templateViews(locale: string): OnboardingTemplateView[] {
    const copy = getMessages(locale).onboarding as unknown as Record<string, string>;
    return ONBOARDING_TEMPLATES.map((t) => ({
      id: t.id,
      slug: t.slug,
      lengthMinutes: t.lengthMinutes,
      title: copy[t.titleKey] ?? t.id,
      description: copy[t.descriptionKey] ?? '',
    }));
  }

  /**
   * `isStaffAccessGrant` is plumbed but always false today: Calendars has no
   * staff-access seam yet. The exemption lives in the engine predicate (and is
   * unit-tested there), so wiring it later is a one-line change here rather
   * than a rule to rebuild.
   */
  gatesFor(p: HostPrincipal) {
    return getOnboardingGates(this.db, p.accountId, p.memberId, { isStaffAccessGrant: false });
  }

  private async externalIdFor(p: HostPrincipal): Promise<string | null> {
    const row = await this.db.get<{ external_id: string | null }>(
      sql`SELECT external_id FROM member WHERE id = ${p.memberId} AND account_id = ${p.accountId} LIMIT 1`,
    );
    return row?.external_id && row.external_id.length > 0 ? row.external_id : null;
  }

  /**
   * Everything the wizard needs in one payload: which gates are owed, which
   * questions this cohort answers, and the templates to choose from. One
   * round-trip, so the wizard never has to ask a second endpoint which step to
   * render — flicker costs most on a first-run screen.
   */
  async getState(p: HostPrincipal): Promise<OnboardingState> {
    const [gates, locale] = await Promise.all([this.gatesFor(p), this.localeFor(p)]);

    // Only probe when gate 1 is actually owed. The cohort decides which
    // QUESTIONS to ask, so it is meaningless once qualification is settled —
    // and an upstream call on every /onboarding load would be pure latency.
    //
    // When the gate is NOT owed, `questionKeys` is empty rather than the
    // default cohort's list: nothing was probed, so claiming a question set
    // would assert a decision that was never made. (`cohort` still carries the
    // fail-closed default because the contract needs a value; an empty
    // `questionKeys` is the field that says "no questions are owed".)
    const cohort: OnboardingCohort = gates.onboardingRequired
      ? resolveCohort(await this.probeCohort(await this.externalIdFor(p)))
      : 'dapta';

    return {
      onboardingRequired: gates.onboardingRequired,
      setupRequired: gates.setupRequired,
      cohort,
      questionKeys: gates.onboardingRequired ? [...cohortQuestionKeys(cohort)] : [],
      templates: this.templateViews(locale),
    };
  }

  /**
   * Gate 1. The claim is write-once at the SQL level, so a second submission —
   * a double-click, a retried request, or a second admin racing the first —
   * preserves the original answers rather than overwriting the workspace's
   * description of itself. Reported as success either way: from the caller's
   * point of view the gate is satisfied, which is all it asked about.
   */
  async submitQualification(
    p: HostPrincipal,
    input: OnboardingQualificationInput,
  ): Promise<{ ok: true; claimed: boolean }> {
    const result = await claimQualification(
      this.db,
      p.accountId,
      input.answers as OnboardingAnswers,
    );
    return { ok: true, claimed: result.claimed };
  }

  /**
   * Gate 2 — create this host's first event type from the server-side registry.
   * The client named a template id and nothing else; duration, slug, title and
   * intake fields all come from the registry, so a hostile client cannot mint
   * an event type with an arbitrary shape.
   */
  async submitSetup(p: HostPrincipal, input: OnboardingSetupInput) {
    const template = getOnboardingTemplate(input.templateId);
    // Unreachable through the zod contract, but this is the boundary that makes
    // "the client may only ever NAME a template" true — so it is checked here.
    if (!template) throw new Error(`Unknown onboarding template: ${input.templateId}`);

    const locale = await this.localeFor(p);
    const copy = getMessages(locale).onboarding as unknown as Record<string, string>;

    const member = await this.db.get<{ default_schedule_id: string | null }>(
      sql`SELECT default_schedule_id FROM member WHERE id = ${p.memberId} LIMIT 1`,
    );

    const bookingFields = template.intake.map((f) => ({
      name: f.name,
      label: copy[f.labelKey] ?? f.name,
      type: f.type,
      required: f.required,
    }));

    // A host may already own the template's slug — they abandoned the wizard
    // after creating one, or built the same event by hand. Suffix rather than
    // fail: this gate exists to leave them bookable, not to explain a collision.
    for (const slug of slugCandidates(template)) {
      const created = await createEventType(this.db, p.accountId, p.memberId, {
        slug,
        title: copy[template.titleKey] ?? template.id,
        description: copy[template.descriptionKey] ?? null,
        lengthMinutes: template.lengthMinutes,
        scheduleId: member?.default_schedule_id ?? null,
        hidden: false,
        bookingFields,
      });
      if (created.ok) return created.value;
      if (created.reason !== 'SLUG_TAKEN') {
        throw new Error(`Could not create the starter event type: ${created.reason}`);
      }
    }
    throw new Error('Could not find a free slug for the starter event type.');
  }
}

/** `demo`, then `demo-2` … `demo-10`. Bounded so a pathological account cannot spin. */
function* slugCandidates(template: OnboardingTemplate): Generator<string> {
  yield template.slug;
  for (let n = 2; n <= 10; n++) yield `${template.slug}-${n}`;
}
