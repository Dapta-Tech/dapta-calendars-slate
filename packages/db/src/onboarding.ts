/**
 * Onboarding's data layer — the reads behind the two gates of ADR 0002 and the
 * write-once qualification claim. The VERDICTS live in @slate/engine as pure
 * predicates; this file only fetches what they need and performs the write.
 *
 * Account-scoped throughout: every function takes the caller's accountId and
 * uses it in the WHERE clause (invariant 4). The one deliberate cross-account
 * read is `personQualifiedElsewhere`, which exists precisely to look outside
 * the current workspace — it reads nothing but a boolean out of the others.
 */
import { sql } from 'drizzle-orm';
import {
  qualificationRequired,
  setupRequired,
  type OnboardingQuestionKey,
} from '@slate/engine';
import type { Db } from './client';
import { jsonParam, parseJsonColumn } from './repository';

/** The qualification answers as stored — a partial map over Forms' bank. */
export type OnboardingAnswers = Partial<Record<OnboardingQuestionKey, string>>;

export interface AccountOnboarding {
  onboarding: OnboardingAnswers | null;
  /** Write-once claim, epoch-ms. NULL = this account still owes gate 1. */
  completedAt: number | null;
}

export async function getAccountOnboarding(db: Db, accountId: string): Promise<AccountOnboarding> {
  const row = await db.get<{ onboarding: unknown; onboarding_completed_at: number | null }>(
    sql`SELECT onboarding, onboarding_completed_at FROM account WHERE id = ${accountId} LIMIT 1`,
  );
  if (!row) return { onboarding: null, completedAt: null };
  return {
    onboarding: parseJsonColumn<OnboardingAnswers | null>(row.onboarding, null),
    completedAt: row.onboarding_completed_at == null ? null : Number(row.onboarding_completed_at),
  };
}

/**
 * Gate 2's measure, and the fix at the heart of #84: how many PUBLISHED event
 * types does this host own personally?
 *
 * The three qualifiers are each load-bearing:
 *  - `member_id = ?` — a TEAM event the member merely hosts does not put
 *    anything on /account/handle, which is the page the gate is about;
 *  - `team_id IS NULL` — belt and braces against a row carrying both;
 *  - `hidden = 0` — an unpublished event type renders an empty public page just
 *    as reliably as no event type at all.
 *
 * The old `hasBookingLink` measured the member's handle instead, which is
 * auto-created for everyone — so it reported "bookable" to every host in the
 * product while their public page rendered nothing.
 */
export async function countPublishedEventTypes(db: Db, memberId: string): Promise<number> {
  const row = await db.get<{ n: number }>(
    sql`SELECT COUNT(*) AS n FROM event_type
        WHERE member_id = ${memberId} AND team_id IS NULL AND hidden = 0`,
  );
  return Number(row?.n ?? 0);
}

/**
 * Has this HUMAN already answered the commercial questions in some other
 * workspace? Forms reaches for the same check (`humanHasCompletedOnboarding`)
 * so that someone invited into a second workspace is not re-interrogated about
 * a company they already described.
 *
 * Identity is `external_id` (the IAM `sub`) first and `email` second. Both
 * comparisons are explicitly non-NULL: a member with neither must never match
 * every other member with neither, which would silently exempt that whole
 * cohort from a gate they genuinely owe.
 */
export async function personQualifiedElsewhere(
  db: Db,
  accountId: string,
  memberId: string,
): Promise<boolean> {
  const me = await db.get<{ external_id: string | null; email: string | null }>(
    sql`SELECT external_id, email FROM member WHERE id = ${memberId} AND account_id = ${accountId} LIMIT 1`,
  );
  if (!me) return false;
  const externalId = me.external_id && me.external_id.length > 0 ? me.external_id : null;
  const email = me.email && me.email.length > 0 ? me.email : null;
  if (!externalId && !email) return false;

  // The identity predicate is BUILT from the identities that exist rather than
  // written once with `${maybeNull} IS NOT NULL` guards. Postgres cannot infer
  // the type of a bound parameter used only in `IS NOT NULL` and rejects the
  // statement outright (42P18, "could not determine data type of parameter") —
  // a break SQLite never reproduces, so it would have reached production green.
  // Both identities are non-null here by the guard above, so no dead parameter
  // is ever bound.
  const byExternalId = sql`m.external_id = ${externalId}`;
  const byEmail = sql`m.email = ${email}`;
  const identityMatch =
    externalId && email
      ? sql`(${byExternalId} OR ${byEmail})`
      : externalId
        ? byExternalId
        : byEmail;

  const hit = await db.get<{ n: number }>(
    sql`SELECT 1 AS n
          FROM member m
          JOIN account a ON a.id = m.account_id
         WHERE m.account_id <> ${accountId}
           AND a.onboarding_completed_at IS NOT NULL
           AND ${identityMatch}
         LIMIT 1`,
  );
  return !!hit;
}

export interface OnboardingGates {
  onboardingRequired: boolean;
  setupRequired: boolean;
}

/**
 * The two server-side verdicts behind `GET /v1/me`. The API is the single
 * authority here: the web app must never derive a gate from an empty
 * event-type list, which is what produces redirect loops and first-paint
 * flicker (#65 → Routing and authority).
 *
 * `isStaffAccessGrant` is passed through from the auth layer — support staff
 * looking at a workspace are not a lead and are never asked to qualify it.
 */
export async function getOnboardingGates(
  db: Db,
  accountId: string,
  memberId: string,
  opts: { isStaffAccessGrant?: boolean } = {},
): Promise<OnboardingGates> {
  const row = await db.get<{
    role: string;
    status: string;
    onboarding_completed_at: number | null;
  }>(
    sql`SELECT m.role AS role, m.status AS status, a.onboarding_completed_at AS onboarding_completed_at
          FROM member m
          JOIN account a ON a.id = m.account_id
         WHERE m.id = ${memberId} AND m.account_id = ${accountId}
         LIMIT 1`,
  );
  // An unresolvable principal owes nothing — a gate is a nudge, never a place
  // to surface a lookup failure as an infinite redirect.
  if (!row) return { onboardingRequired: false, setupRequired: false };

  const completedAt =
    row.onboarding_completed_at == null ? null : Number(row.onboarding_completed_at);

  // Cheap short-circuit before the cross-account probe: the person-level check
  // only ever REMOVES the obligation, so it is pointless once the account is
  // claimed or the caller is a plain member. /v1/me is hot — this keeps the
  // common (already-onboarded) request at two queries.
  const couldOweQualification =
    !opts.isStaffAccessGrant &&
    completedAt === null &&
    (row.role === 'owner' || row.role === 'admin');

  const [qualifiedElsewhere, publishedEventTypeCount] = await Promise.all([
    couldOweQualification ? personQualifiedElsewhere(db, accountId, memberId) : Promise.resolve(false),
    countPublishedEventTypes(db, memberId),
  ]);

  return {
    onboardingRequired: qualificationRequired({
      role: row.role,
      accountOnboardingCompletedAt: completedAt,
      personQualifiedElsewhere: qualifiedElsewhere,
      isStaffAccessGrant: !!opts.isStaffAccessGrant,
    }),
    setupRequired: setupRequired({ status: row.status, publishedEventTypeCount }),
  };
}

export interface QualificationClaim {
  /** True only when THIS call performed the claim. */
  claimed: boolean;
  /** The winning claim time — an earlier one when `claimed` is false. */
  completedAt: number | null;
}

/**
 * Claim gate 1 write-once.
 *
 * The DATA guarantee is the `IS NULL` guard inside the UPDATE: two submissions
 * cannot both write, so the second matches no rows and the workspace keeps the
 * answers it was first given. That holds unconditionally, on both dialects.
 *
 * Reporting WHICH call won is the softer half. `db.run` returns no row count on
 * either dialect, so the outcome has to be read back — and reading it back as
 * "is the stored timestamp the one I passed?" is wrong the moment two calls
 * land in the same millisecond, which an in-memory SQLite test does routinely:
 * the loser sees its own `now` in the row and reports a claim it never made.
 *
 * So the already-claimed case is answered by a read BEFORE the write, which is
 * both deterministic and the only case that happens in practice (a second
 * submission arrives from a retry or another admin, not inside one tick).
 * Under genuinely simultaneous first claims the attribution is best-effort;
 * the stored answers are not.
 */
export async function claimQualification(
  db: Db,
  accountId: string,
  answers: OnboardingAnswers,
  now = Date.now(),
): Promise<QualificationClaim> {
  const before = await getAccountOnboarding(db, accountId);
  if (before.completedAt !== null) return { claimed: false, completedAt: before.completedAt };

  await db.run(
    sql`UPDATE account
           SET onboarding = ${jsonParam(db, answers)}, onboarding_completed_at = ${now}
         WHERE id = ${accountId} AND onboarding_completed_at IS NULL`,
  );
  const after = await getAccountOnboarding(db, accountId);
  return { claimed: after.completedAt === now, completedAt: after.completedAt };
}
