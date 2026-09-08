/**
 * Session-scoped "I'll do this later" marker for the onboarding wizard.
 *
 * Without an escape hatch the admin guard is a trap: it redirects while either
 * gate is owed, and #65 designates the Home "Get bookable" checklist as the
 * recovery path for a host who abandons the wizard — a path that is
 * unreachable if the redirect never yields. No Max-Age, so it dies with the
 * browser session and the wizard greets them again next visit; the gate itself
 * is never marked satisfied, because it isn't.
 */
export const ONBOARDING_SKIP_COOKIE = 'slate.onboarding.skipped';
