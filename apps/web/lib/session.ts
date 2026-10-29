/** OSS local-auth session cookie name (the FE gate for the dashboard). */
export const SESSION_COOKIE = 'slate_session';

/**
 * The name a sign-in cookie is written under. In production it carries the
 * `__Host-` prefix: a browser accepts such a cookie only from this exact host,
 * over https (or localhost), with `Path=/` and no `Domain`, so no sibling host
 * on the same site (a booking host such as `book.<domain>` that runs hosts' own
 * tags) can plant one the dashboard would read ("cookie tossing"). Outside
 * production (local development, tests) the plain name stays.
 */
export function hostCookieName(name: string): string {
  return process.env.NODE_ENV === 'production' ? `__Host-${name}` : name;
}

/**
 * Whether a session written before the `__Host-` prefix may still be read
 * under its plain name, so nobody is signed out by the release: only while no
 * other host of this deployment serves booking pages. Once one does
 * (`PUBLIC_BOOKING_URL` on an origin of its own), a plain-named cookie may have
 * been planted from there with `Domain=<site>` and is never read: a session
 * that has not moved over by then signs in once more.
 */
export function legacySessionReadable(env: Record<string, string | undefined> = process.env): boolean {
  const booking = originOf(env.PUBLIC_BOOKING_URL);
  return !booking || booking === originOf(env.PUBLIC_APP_URL);
}

function originOf(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    return new URL(value.trim()).origin;
  } catch {
    return null;
  }
}

type CookieReader = { get(name: string): { value: string } | undefined };

/**
 * A sign-in cookie's value under its `__Host-` name. `legacy` also reads the
 * plain name, only while no `__Host-` cookie exists: the session's migration
 * (see `legacySessionReadable`). The login's own short-lived cookies never
 * take it: a login in flight across the release just starts again.
 */
export function readHostCookie(jar: CookieReader, name: string, opts: { legacy?: boolean } = {}): string | undefined {
  const current = hostCookieName(name);
  const value = jar.get(current)?.value;
  if (value !== undefined || current === name || !opts.legacy) return value;
  return jar.get(name)?.value;
}

type CookieWriter = {
  get(name: string): { value: string } | undefined;
  set(name: string, value: string, options: Record<string, unknown>): unknown;
};

/** What a `__Host-` cookie must carry, whatever the caller passed. */
const hostAttributes = (name: string, options: Record<string, unknown>) =>
  name.startsWith('__Host-') ? { ...options, path: '/', domain: undefined, secure: true } : { ...options, path: '/', domain: undefined };

/** An expired write of the plain name, as it was set (host-only, `Path=/`). */
const expirePlain = (options: Record<string, unknown>) => ({ ...options, path: '/', domain: undefined, maxAge: 0 });

/** Write a sign-in cookie under its current name, and retire the older one. */
export function writeHostCookie(jar: CookieWriter, name: string, value: string, options: Record<string, unknown>): void {
  const current = hostCookieName(name);
  jar.set(current, value, hostAttributes(current, options));
  if (current !== name && jar.get(name) !== undefined) jar.set(name, '', expirePlain(options));
}

/**
 * Remove a sign-in cookie under both names. A `__Host-` cookie is removed by
 * an expired write that carries the same attributes (`Secure`, `Path=/`); a
 * bare delete without `Secure` is refused by the browser and would leave it.
 */
export function deleteHostCookie(jar: CookieWriter, name: string, options: Record<string, unknown>): void {
  const current = hostCookieName(name);
  jar.set(current, '', { ...hostAttributes(current, options), maxAge: 0 });
  if (current !== name) jar.set(name, '', expirePlain(options));
}
