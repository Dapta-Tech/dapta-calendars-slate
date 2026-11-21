/**
 * Which screen the hosted login opens on: sign-in (always, until now) or
 * sign-up.
 *
 * A product landing links into the app in two ways: a log-in link and a
 * "create an account" call to action. Both point at the app ROOT, not at the
 * login route: the root is a page, so the middleware parks the campaign tags
 * and the landing's analytics id there for the login round trip, which it
 * never does on an `/api/` route. The call to action adds `?screen=sign-up`;
 * on a WorkOS build the root passes it on to `/api/auth/login`, which asks
 * the identity service for its sign-up screen (a local build has no hosted
 * screen to pick, and ignores it). Everything else opens on sign-in exactly
 * as before, including the `/login` redirect a signed-out visit to a
 * dashboard page goes through, which never carries it.
 *
 * One allowlisted value, compared exactly: the parameter arrives from any URL
 * and the route turns it into a parameter of the identity service. `screen`
 * is this app's own name for it; only the login route knows what the identity
 * service calls it.
 *
 * PURE on purpose (no `next/headers`): the root page, the login route and the
 * specs read it the same way.
 */

/** The query parameter the screen choice travels in. */
export const SCREEN_PARAM = 'screen';

/** The one value it takes: the sign-up screen. */
export const SIGN_UP_SCREEN = 'sign-up';

/** Whether a raw `?screen=` value asks for the sign-up screen. Exactly `sign-up`, nothing else. */
export function wantsSignUp(raw: unknown): boolean {
  return raw === SIGN_UP_SCREEN;
}
