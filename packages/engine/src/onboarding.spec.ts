import { describe, it, expect } from 'vitest';
import {
  ONBOARDING_QUESTION_KEYS,
  ONBOARDING_COHORTS,
  ONBOARDING_TEMPLATES,
  cohortQuestionKeys,
  resolveCohort,
  getOnboardingTemplate,
  isOnboardingTemplateId,
  qualificationRequired,
  setupRequired,
} from './onboarding';

describe('onboarding question bank', () => {
  it('is Forms’ exact bank, in order (the IAM lead-score contract)', () => {
    expect([...ONBOARDING_QUESTION_KEYS]).toEqual([
      'phone',
      'industry',
      'crm',
      'lead_volume',
      'lead_source',
      'use_case',
    ]);
  });

  it('asks all six of the cold cohort and two of the dapta cohort', () => {
    expect(cohortQuestionKeys('cold')).toHaveLength(6);
    expect(cohortQuestionKeys('dapta')).toHaveLength(2);
  });

  it('never asks a key outside the bank', () => {
    for (const cohort of ONBOARDING_COHORTS) {
      for (const key of cohortQuestionKeys(cohort)) {
        expect(ONBOARDING_QUESTION_KEYS).toContain(key);
      }
    }
  });
});

describe('cohort probe resolution', () => {
  it('resolves a known upstream identity to the short cohort', () => {
    expect(resolveCohort({ outcome: 'known' })).toBe('dapta');
  });

  it('resolves a definitive upstream miss to the full cohort', () => {
    expect(resolveCohort({ outcome: 'unknown' })).toBe('cold');
  });

  // The load-bearing rule from #65: an error must never widen the interrogation.
  it('FAILS CLOSED to dapta on any probe error — the cohort that asks less', () => {
    expect(resolveCohort({ outcome: 'error' })).toBe('dapta');
  });

  it('fails closed on a null/undefined probe too', () => {
    expect(resolveCohort(null)).toBe('dapta');
    expect(resolveCohort(undefined)).toBe('dapta');
  });

  // `cold` is answered only when there is no IAM to probe at all — a bare fork.
  it('answers cold only when no upstream is configured', () => {
    expect(resolveCohort({ outcome: 'not_configured' })).toBe('cold');
  });
});

describe('template registry', () => {
  it('ships the four templates from #65, each with a distinct id and slug', () => {
    const ids = ONBOARDING_TEMPLATES.map((t) => t.id);
    expect(ids).toEqual(['30min', '15min', '45min', '60min']);
    expect(new Set(ONBOARDING_TEMPLATES.map((t) => t.slug)).size).toBe(4);
  });

  it('carries duration and i18n keys, never literal copy (invariant 9)', () => {
    for (const t of ONBOARDING_TEMPLATES) {
      expect(t.lengthMinutes).toBeGreaterThan(0);
      expect(t.titleKey).toMatch(/^[a-zA-Z0-9_]+$/);
      expect(t.descriptionKey).toMatch(/^[a-zA-Z0-9_]+$/);
    }
  });

  it('matches each template’s duration to its id', () => {
    expect(getOnboardingTemplate('30min')?.lengthMinutes).toBe(30);
    expect(getOnboardingTemplate('15min')?.lengthMinutes).toBe(15);
    expect(getOnboardingTemplate('45min')?.lengthMinutes).toBe(45);
    expect(getOnboardingTemplate('60min')?.lengthMinutes).toBe(60);
  });

  // The client may only ever NAME a template; it may never supply a config.
  it('rejects an unknown template id', () => {
    expect(isOnboardingTemplateId('30min')).toBe(true);
    expect(isOnboardingTemplateId('90min')).toBe(false);
    expect(isOnboardingTemplateId('')).toBe(false);
    expect(isOnboardingTemplateId('__proto__')).toBe(false);
    expect(getOnboardingTemplate('90min')).toBeUndefined();
  });

  it('gives every template a slug safe for a public booking URL', () => {
    for (const t of ONBOARDING_TEMPLATES) expect(t.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });
});

describe('gate 1 — qualification (account level, owner/admin only)', () => {
  const base = {
    role: 'owner',
    accountOnboardingCompletedAt: null,
    personQualifiedElsewhere: false,
    isStaffAccessGrant: false,
  };

  it('is owed by an owner of an unclaimed account', () => {
    expect(qualificationRequired(base)).toBe(true);
  });

  it('is owed by an admin too', () => {
    expect(qualificationRequired({ ...base, role: 'admin' })).toBe(true);
  });

  it('is NEVER owed by a plain member — they answer setup only', () => {
    expect(qualificationRequired({ ...base, role: 'member' })).toBe(false);
  });

  // Write-once: the claim is a permanent stamp, never re-asked.
  it('stops being owed once the account carries the claim', () => {
    expect(qualificationRequired({ ...base, accountOnboardingCompletedAt: 1_700_000_000_000 })).toBe(false);
  });

  it('treats a zero-epoch claim as claimed, not as absent', () => {
    expect(qualificationRequired({ ...base, accountOnboardingCompletedAt: 0 })).toBe(false);
  });

  it('exempts a staff access grant — support is not a lead', () => {
    expect(qualificationRequired({ ...base, isStaffAccessGrant: true })).toBe(false);
  });

  it('never re-interrogates a person already qualified in another workspace', () => {
    expect(qualificationRequired({ ...base, personQualifiedElsewhere: true })).toBe(false);
  });
});

describe('gate 2 — setup (member level, every active member)', () => {
  it('is owed by an active member with no event types of their own', () => {
    expect(setupRequired({ status: 'active', publishedEventTypeCount: 0 })).toBe(true);
  });

  it('is satisfied by one published event type', () => {
    expect(setupRequired({ status: 'active', publishedEventTypeCount: 1 })).toBe(false);
  });

  // ADR 0002: setup has NO completion claim. Deleting the last event type
  // guides the host again rather than stranding them on an empty public page.
  it('becomes owed again when the last event type is deleted', () => {
    const after = setupRequired({ status: 'active', publishedEventTypeCount: 0 });
    expect(after).toBe(true);
  });

  it('is owed by an invited member the same as any other — once active', () => {
    expect(setupRequired({ status: 'active', publishedEventTypeCount: 0 })).toBe(true);
  });

  it('is not owed by a member who has not signed in yet', () => {
    expect(setupRequired({ status: 'invited', publishedEventTypeCount: 0 })).toBe(false);
  });

  it('is not owed by a disabled member', () => {
    expect(setupRequired({ status: 'disabled', publishedEventTypeCount: 0 })).toBe(false);
  });
});
