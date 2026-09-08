'use server';

import { cookies } from 'next/headers';
import { redirect, unstable_rethrow } from 'next/navigation';
import { adminApi } from '@/lib/admin-api';
import { ONBOARDING_SKIP_COOKIE } from '@/lib/onboarding';

export type OnboardingActionResult = { ok: true } | { ok: false; error: string };

/** Gate 1 — claim the workspace's qualification answers (write-once server-side). */
export async function submitQualificationAction(
  answers: Record<string, string>,
): Promise<OnboardingActionResult> {
  try {
    await adminApi.submitQualification(answers);
    return { ok: true };
  } catch (e) {
    // The 401 path inside adminApi redirects; never swallow that as an error.
    unstable_rethrow(e);
    return { ok: false, error: e instanceof Error ? e.message : 'unknown' };
  }
}

/**
 * Gate 2 — create the host's first event type from a named template, then leave
 * the wizard. The redirect is deliberately OUTSIDE the try: `redirect()` works
 * by throwing, so catching it here would report a successful setup as a failure.
 */
export async function submitSetupAction(templateId: string): Promise<OnboardingActionResult> {
  try {
    await adminApi.submitOnboardingSetup(templateId);
  } catch (e) {
    unstable_rethrow(e);
    return { ok: false, error: e instanceof Error ? e.message : 'unknown' };
  }
  redirect('/admin');
}

/**
 * "Skip for now" — set the session marker the admin guard honours, so the Home
 * checklist (the designated recovery path) is reachable. The gate itself stays
 * unsatisfied: this records that the host asked to move on, not that they are
 * bookable.
 */
export async function skipOnboardingAction(): Promise<void> {
  const jar = await cookies();
  jar.set(ONBOARDING_SKIP_COOKIE, '1', {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
  });
  redirect('/admin');
}
