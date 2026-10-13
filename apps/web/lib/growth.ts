/**
 * Growth-loop env binding — the only place the web app reads the badge/CTA
 * configuration. Pure logic lives in @slate/shared (tested there).
 *
 * Like the app-switcher's platform URL, the destination comes only from the
 * deployment: NEXT_PUBLIC_SIGNUP_URL unset → no badge, no CTA (a bare fork
 * carries no Dapta branding); NEXT_PUBLIC_HIDE_BADGE turns them off even when
 * a destination is configured.
 *
 * NEXT_PUBLIC_* are referenced as full static property accesses so Next can
 * inline them into the client bundle too (the confirmation CTA lives in the
 * BookingFlow client island).
 */
import { badgeHidden, buildSignupUrl, type SignupMedium } from '@slate/shared';

/**
 * Signup destination + UTM tags, or null when the growth loop is off.
 *
 * `show` is the page's `showBranding`, the API's answer to "does this
 * account's page carry the Dapta branding?" (`showDaptaBranding` in
 * @slate/shared: off only for an account that asked to hide it while it is a
 * paying Dapta AI customer). Required, so no surface can forget to ask.
 */
export function signupHref(
  medium: SignupMedium,
  accountCode: string | null | undefined,
  show: boolean,
): string | null {
  if (!show) return null;
  if (badgeHidden(process.env.NEXT_PUBLIC_HIDE_BADGE)) return null;
  return buildSignupUrl({ baseUrl: process.env.NEXT_PUBLIC_SIGNUP_URL, medium, accountCode });
}

/**
 * Read a public payload's `showBranding`. Absent (an older API, or a page with
 * no account behind it) is the default: the branding shows.
 */
export function brandingShown(payload: { showBranding?: boolean } | null | undefined): boolean {
  return payload?.showBranding !== false;
}
