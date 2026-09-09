/**
 * Session-scoped "I'll do this later" marker for the onboarding wizard.
 *
 * Without an escape hatch the admin guard is a trap: it redirects while either
 * gate is owed, and #65 designates the Home "Get bookable" checklist as the
 * recovery path for a host who abandons the wizard — a path that is
 * unreachable if the redirect never yields. No Max-Age, so it dies with the
 * browser session and the wizard greets them again next visit; the gate itself
 * is never marked satisfied, because it isn't.
 *
 * NOT a security boundary: neither gate is one. The API reports the verdicts
 * and never refuses a request on them, so forging this cookie costs the forger
 * a wizard and nothing more. Never hang an authorization decision on it.
 */
export const ONBOARDING_SKIP_COOKIE = 'slate.onboarding.skipped';
