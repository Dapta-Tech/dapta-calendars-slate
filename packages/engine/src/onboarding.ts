/**
 * Onboarding's pure core — the two gates of ADR 0002, the cohort rule, and the
 * server-side template registry. No I/O: the probe is performed by the API and
 * its OUTCOME is handed to `resolveCohort`, so the fail-closed rule stays a
 * unit-testable function rather than an error branch buried in a fetch.
 *
 * Copy never lives here. Templates carry i18n catalog KEYS (invariant 9); the
 * API resolves them against `@slate/shared` in the member's locale at creation.
 */

// --- The question bank ----------------------------------------------------

/**
 * IDENTICAL to Forms, in Forms' order. These `question_key`s are the contract
 * with the IAM's `POST /onboarding/responses`, which computes the lead score —
 * inventing Calendars-specific keys would leave every Calendars lead unscored
 * (#65). Scheduling-flavoured questions were rejected for exactly that reason.
 */
export const ONBOARDING_QUESTION_KEYS = [
  'phone',
  'industry',
  'crm',
  'lead_volume',
  'lead_source',
  'use_case',
] as const;
export type OnboardingQuestionKey = (typeof ONBOARDING_QUESTION_KEYS)[number];

/**
 * `dapta` = the person is already known upstream, so the commercial facts
 * (industry, CRM, volume, acquisition source) are already in Dapta's CRM and
 * re-asking them is friction that also risks contradicting the better answer.
 * `cold` = a stranger; ask the full bank.
 */
export const ONBOARDING_COHORTS = ['dapta', 'cold'] as const;
export type OnboardingCohort = (typeof ONBOARDING_COHORTS)[number];

/**
 * The two the short cohort still owes: `phone` (reachability — routinely absent
 * upstream) and `use_case` (product-specific intent, which no Dapta AI signup
 * can have answered). One constant so re-aligning with Forms' live short cohort
 * is a one-line change rather than a rewrite.
 */
export const DAPTA_COHORT_QUESTION_KEYS: readonly OnboardingQuestionKey[] = ['phone', 'use_case'];

export function cohortQuestionKeys(cohort: OnboardingCohort): readonly OnboardingQuestionKey[] {
  return cohort === 'dapta' ? DAPTA_COHORT_QUESTION_KEYS : ONBOARDING_QUESTION_KEYS;
}

// --- The cohort probe -----------------------------------------------------

/**
 * What the upstream identity probe concluded. `error` covers timeout, non-2xx
 * and transport failure alike — the caller must not try to distinguish them,
 * because the response to all three is identical.
 */
export type CohortProbeResult =
  | { outcome: 'known' }
  | { outcome: 'unknown' }
  | { outcome: 'error' }
  | { outcome: 'not_configured' };

/**
 * FAILS CLOSED to `dapta` — the cohort that asks LESS (#65). An IAM blip must
 * never widen the interrogation: six questions fired at someone Dapta already
 * knows is a worse failure than two fired at a stranger, because the answers
 * are then written over a better-attributed contact.
 *
 * `cold` is answered ONLY on a definitive upstream miss. `not_configured` is
 * not a cohort question at all — see `qualificationApplies`: with no upstream
 * there is no funnel, so the gate does not apply and no cohort is consulted.
 * It maps to the short cohort here purely so a caller that ignores that rule
 * still errs toward asking less.
 */
export function resolveCohort(probe: CohortProbeResult | null | undefined): OnboardingCohort {
  if (!probe) return 'dapta';
  return probe.outcome === 'unknown' ? 'cold' : 'dapta';
}

/**
 * Does gate 1 apply to this DEPLOYMENT at all?
 *
 * Qualification exists to feed a growth funnel. A deployment with no upstream
 * identity service has no funnel, so the questions have no reader — and asking
 * them anyway would hard-trap the first admin of a bare fork behind six
 * commercial questions ("Which CRM does your team use?") before they can reach
 * their own dashboard. That is the wrong default for a self-hostable product
 * and contradicts the repo's own posture that nothing configured still runs.
 *
 * Gate 2 is unaffected: creating a first event type is product value that every
 * deployment wants, and it carries a skip.
 */
export function qualificationApplies(hasUpstreamIdentityService: boolean): boolean {
  return hasUpstreamIdentityService;
}

// --- The template registry ------------------------------------------------

export const ONBOARDING_TEMPLATE_IDS = ['30min', '15min', '45min', '60min'] as const;
export type OnboardingTemplateId = (typeof ONBOARDING_TEMPLATE_IDS)[number];

/** An intake question on a template, named by i18n key rather than by label. */
export interface OnboardingTemplateField {
  name: string;
  type: 'text' | 'textarea';
  required: boolean;
  labelKey: string;
}

export interface OnboardingTemplate {
  id: OnboardingTemplateId;
  /** Public booking-URL segment. Collides are resolved by the caller, not here. */
  slug: string;
  lengthMinutes: number;
  titleKey: string;
  descriptionKey: string;
  intake: readonly OnboardingTemplateField[];
}

const TOPIC_FIELD: OnboardingTemplateField = {
  name: 'topic',
  type: 'textarea',
  required: false,
  labelKey: 'intakeTopic',
};
const COMPANY_FIELD: OnboardingTemplateField = {
  name: 'company',
  type: 'text',
  required: true,
  labelKey: 'intakeCompany',
};

/**
 * Server-side registry, mirroring Forms: the client may only ever NAME a
 * template id — it may never supply a config. That is what keeps a hostile
 * client from minting an event type with arbitrary duration, slug or fields.
 *
 * Reminders are not carried here: they fire today from the account-level
 * default (24h + 1h). Unit R (#68) makes them per-event-type and is the right
 * place to add a per-template override — an inert field here would be dead code.
 */
export const ONBOARDING_TEMPLATES: readonly OnboardingTemplate[] = [
  {
    id: '30min',
    slug: '30-min-meeting',
    lengthMinutes: 30,
    titleKey: 'template30MinTitle',
    descriptionKey: 'template30MinDesc',
    intake: [TOPIC_FIELD],
  },
  {
    id: '15min',
    slug: 'quick-call',
    lengthMinutes: 15,
    titleKey: 'template15MinTitle',
    descriptionKey: 'template15MinDesc',
    intake: [TOPIC_FIELD],
  },
  {
    id: '45min',
    slug: 'demo',
    lengthMinutes: 45,
    titleKey: 'template45MinTitle',
    descriptionKey: 'template45MinDesc',
    intake: [COMPANY_FIELD, TOPIC_FIELD],
  },
  {
    id: '60min',
    slug: 'one-on-one',
    lengthMinutes: 60,
    titleKey: 'template60MinTitle',
    descriptionKey: 'template60MinDesc',
    intake: [TOPIC_FIELD],
  },
];

const TEMPLATES_BY_ID = new Map<string, OnboardingTemplate>(
  ONBOARDING_TEMPLATES.map((t) => [t.id, t]),
);

/** Map-backed so a prototype key (`__proto__`, `constructor`) can never hit. */
export function getOnboardingTemplate(id: string): OnboardingTemplate | undefined {
  return TEMPLATES_BY_ID.get(id);
}

export function isOnboardingTemplateId(id: string): id is OnboardingTemplateId {
  return TEMPLATES_BY_ID.has(id);
}

// --- The two gates --------------------------------------------------------

export interface QualificationGateInput {
  /** Account-level role: `owner` | `admin` | `member`. */
  role: string;
  /** Write-once claim on the account row; NULL = the account owes qualification. */
  accountOnboardingCompletedAt: number | null;
  /** This human already qualified in ANOTHER workspace (person-level check). */
  personQualifiedElsewhere: boolean;
  /** Staff support access, not a real workspace member. */
  isStaffAccessGrant: boolean;
}

/**
 * Gate 1 — describes the WORKSPACE and its company, so it is owed once per
 * account and only by someone who can speak for it (owner/admin). A plain
 * member answering would send contradictory facts about one business to the
 * growth funnel; ADR 0002 §Why.
 */
export function qualificationRequired(input: QualificationGateInput): boolean {
  if (input.isStaffAccessGrant) return false;
  if (input.role !== 'owner' && input.role !== 'admin') return false;
  if (input.accountOnboardingCompletedAt !== null) return false;
  if (input.personQualifiedElsewhere) return false;
  return true;
}

export interface SetupGateInput {
  /** Member lifecycle: `active` | `invited` | `disabled`. */
  status: string;
  /** Count of this member's OWN published event types (personal, not team). */
  publishedEventTypeCount: number;
}

/**
 * Gate 2 — describes ONE HOST, so every active member owes it, invited members
 * included. There is deliberately no completion claim (ADR 0002 §Consequences):
 * the gate is satisfied by the EXISTENCE of an event type, so a host who
 * abandons the wizard, or later deletes their last event type, is guided again
 * rather than left with a booking link that renders an empty page.
 */
export function setupRequired(input: SetupGateInput): boolean {
  if (input.status !== 'active') return false;
  return input.publishedEventTypeCount === 0;
}
