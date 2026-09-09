import {
  BadRequestException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  Optional,
} from '@nestjs/common';
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
  qualificationApplies,
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
import { GrowthService } from './growth.service';
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
    // Optional for the same reason: O1's existing specs construct this service
    // with two arguments, and a gate must never depend on the funnel.
    @Optional() @Inject(GrowthService) private readonly growth?: GrowthService,
  ) {}

  private readonly log = new Logger('OnboardingService');

  /**
   * Ask the upstream identity service whether it already knows this human.
   *
   * Every failure mode collapses to `error`, because the response to all of
   * them is identical: fail closed to the cohort that asks LESS. The caller
   * must never see a distinction it would be tempted to branch on.
   */
  private async probeCohort(externalId: string | null): Promise<CohortProbeResult> {
    const cached = externalId ? PROBE_CACHE.get(externalId) : undefined;
    if (cached && cached.expiresAt > Date.now()) return cached.result;
    const result = await this.probeCohortUncached(externalId);
    if (externalId) {
      // Bounded so a hostile caller cannot grow the map without limit; the
      // wizard is a first-run screen, so a handful of live entries is normal.
      if (PROBE_CACHE.size >= PROBE_CACHE_MAX) PROBE_CACHE.clear();
      PROBE_CACHE.set(externalId, { result, expiresAt: Date.now() + PROBE_CACHE_TTL_MS });
    }
    return result;
  }

  private async probeCohortUncached(externalId: string | null): Promise<CohortProbeResult> {
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

  /**
   * Resolve one catalog key to a string.
   *
   * The `onboarding` block is NOT flat — it carries the nested `questions` map —
   * so a blind `Record<string, string>` cast would let a future key that points
   * at an object render `[object Object]` into an event type's title, with no
   * type error to catch it. The `typeof` guard is what makes the cast safe.
   */
  private copy(locale: string, key: string, fallback: string): string {
    const block = getMessages(locale).onboarding as unknown as Record<string, unknown>;
    const value = block[key];
    return typeof value === 'string' ? value : fallback;
  }

  private templateViews(locale: string): OnboardingTemplateView[] {
    return ONBOARDING_TEMPLATES.map((t) => ({
      id: t.id,
      slug: t.slug,
      lengthMinutes: t.lengthMinutes,
      title: this.copy(locale, t.titleKey, t.id),
      description: this.copy(locale, t.descriptionKey, ''),
    }));
  }

  /**
   * True when this deployment has an upstream identity service to feed.
   *
   * A MISSING env object is a direct-construction/spec context, not a verdict
   * about a deployment — only a loaded env that lacks the base URL means "this
   * deployment has no upstream". Erring this way keeps the gate ON when the
   * answer is unknown, which is the safe direction: a missed question costs a
   * lead, a suppressed gate costs the funnel silently.
   */
  private get hasUpstream(): boolean {
    return this.env ? !!this.env.ONBOARDING_IAM_BASE_URL : true;
  }

  /**
   * The two verdicts.
   *
   * Gate 1 is suppressed entirely when the deployment has no upstream identity
   * service. Qualification exists to feed a growth funnel; with no funnel the
   * answers have no reader, and asking anyway would hard-trap the first admin
   * of a bare fork behind six commercial questions before they could reach
   * their own dashboard. Gate 2 always applies — a first event type is product
   * value every deployment wants.
   *
   * `isStaffAccessGrant` is plumbed but always false today: Calendars has no
   * staff-access seam yet. The exemption lives in the engine predicate (and is
   * unit-tested there), so wiring it later is a one-line change here rather
   * than a rule to rebuild.
   */
  async gatesFor(p: HostPrincipal) {
    const gates = await getOnboardingGates(this.db, p.accountId, p.memberId, {
      isStaffAccessGrant: false,
    });
    if (!qualificationApplies(this.hasUpstream)) {
      return { ...gates, onboardingRequired: false };
    }
    return gates;
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
    const answers = input.answers as OnboardingAnswers;
    const result = await claimQualification(this.db, p.accountId, answers);

    // O2: the growth funnel is told ONLY by the winner. `claimed` is exact
    // because the write reports its own affected-row count — the correction
    // this service's own history records, made for exactly this call site: two
    // winners here would be two lead scores for one workspace.
    //
    // Enqueue only, never an outbound call (invariant 5), and never allowed to
    // fail the request: the gate is satisfied whatever the funnel makes of it,
    // and a marketing outage must not become a signup outage.
    if (result.claimed && this.growth) {
      try {
        await this.growth.enqueueQualified(p, answers);
      } catch (err) {
        this.log.error(`growth enqueue failed for ${p.accountId}: ${String(err)}`);
      }
    }
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
    if (!template) {
      throw new BadRequestException({
        error: 'UNKNOWN_TEMPLATE',
        message: 'That starter template does not exist.',
      });
    }

    const locale = await this.localeFor(p);

    const member = await this.db.get<{ default_schedule_id: string | null }>(
      sql`SELECT default_schedule_id FROM member
           WHERE id = ${p.memberId} AND account_id = ${p.accountId} LIMIT 1`,
    );

    const bookingFields = template.intake.map((f) => ({
      name: f.name,
      label: this.copy(locale, f.labelKey, f.name),
      type: f.type,
      required: f.required,
    }));

    // A host may already own the template's slug — they abandoned the wizard
    // after creating one, or built the same event by hand. Suffix rather than
    // fail: this gate exists to leave them bookable, not to explain a collision.
    for (const slug of slugCandidates(template)) {
      const created = await createEventType(this.db, p.accountId, p.memberId, {
        slug,
        title: this.copy(locale, template.titleKey, template.id),
        description: this.copy(locale, template.descriptionKey, ''),
        lengthMinutes: template.lengthMinutes,
        scheduleId: member?.default_schedule_id ?? null,
        hidden: false,
        bookingFields,
      });
      if (created.ok) return created.value;
      if (created.reason !== 'SLUG_TAKEN') {
        // Reachable, so it gets the repo's `{ error, message }` shape rather
        // than a raw 500 carrying an internal string (error-visibility.spec.ts).
        throw new InternalServerErrorException({
          error: 'SETUP_FAILED',
          message: 'Could not create your first event type. Please try again.',
        });
      }
    }
    throw new InternalServerErrorException({
      error: 'SETUP_FAILED',
      message: 'Could not create your first event type. Please try again.',
    });
  }
}

/**
 * Short-lived memo of the cohort probe, keyed by upstream identity.
 *
 * `/v1/me/onboarding` carries no rate limit (RateLimitGuard is applied to the
 * public controller only), so without this an authenticated owner of an
 * unqualified account could hold down reload and turn the API into an
 * amplifier against the identity service. The TTL is short because the answer
 * only has to survive one wizard session; O2 persists the resolved cohort
 * alongside the answers and this becomes redundant.
 */
const PROBE_CACHE_TTL_MS = 5 * 60_000;
const PROBE_CACHE_MAX = 1_000;
const PROBE_CACHE = new Map<string, { result: CohortProbeResult; expiresAt: number }>();

/** `demo`, then `demo-2` … `demo-10`. Bounded so a pathological account cannot spin. */
function* slugCandidates(template: OnboardingTemplate): Generator<string> {
  yield template.slug;
  for (let n = 2; n <= 10; n++) yield `${template.slug}-${n}`;
}
