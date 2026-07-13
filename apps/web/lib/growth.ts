/**
 * Growth-loop env binding — the only place the web app reads the badge/CTA
 * configuration. Pure logic lives in @slate/shared (tested there).
 *
 * NEXT_PUBLIC_* are referenced as full static property accesses so Next can
 * inline them into the client bundle too (the confirmation CTA lives in the
 * BookingFlow client island).
 */
import { badgeHidden, buildSignupUrl, type SignupMedium } from '@slate/shared';

/** Open-core kill-switch: forks hide the badge with NEXT_PUBLIC_HIDE_BADGE=1. */
export const showBadge = !badgeHidden(process.env.NEXT_PUBLIC_HIDE_BADGE);

/** Signup destination (NEXT_PUBLIC_SIGNUP_URL, default app.dapta.ai) + UTM tags. */
export function signupHref(medium: SignupMedium, accountCode?: string | null): string {
  return buildSignupUrl({ baseUrl: process.env.NEXT_PUBLIC_SIGNUP_URL, medium, accountCode });
}
