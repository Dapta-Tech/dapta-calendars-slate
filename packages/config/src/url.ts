/**
 * The origin of an http(s) address, or null for anything else: blank,
 * whitespace, not a URL, or another scheme. Trimmed; a path, query or
 * fragment on the value is dropped. One rule for every reader of a configured
 * host (the web's middleware, the API), so a fix lands everywhere at once.
 * Dependency-free, so the web's middleware can load it.
 */
export function httpOrigin(value: string | undefined | null): string | null {
  const s = value?.trim();
  if (!s) return null;
  try {
    const url = new URL(s);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}
