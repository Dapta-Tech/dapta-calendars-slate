import 'server-only';

/**
 * The API rejects an INTERNAL_API_SECRET shorter than this at boot (see
 * packages/config/src/env.ts), so the web must not send one either.
 */
export const INTERNAL_API_SECRET_MIN_LENGTH = 32;

/**
 * INTERNAL_API_SECRET as the web may use it: the value when it is long enough
 * for the API to accept, else undefined (treated as unset, so the web forwards
 * nothing and the API keys on the web server, as it does without the feature).
 */
export function internalApiSecret(value: string | undefined = process.env.INTERNAL_API_SECRET): string | undefined {
  return value && value.length >= INTERNAL_API_SECRET_MIN_LENGTH ? value : undefined;
}

/**
 * The startup warning for a secret the web will not send, or null when there
 * is nothing to say: set but too short for the API, or set while API_URL is
 * not (the web sends it only to an API named explicitly, never to the public
 * NEXT_PUBLIC_API_URL fallback). Never echoes the value.
 */
export function internalApiSecretWarning(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.INTERNAL_API_SECRET;
  if (!value) return null;
  if (!internalApiSecret(value)) {
    return (
      `INTERNAL_API_SECRET is shorter than ${INTERNAL_API_SECRET_MIN_LENGTH} characters; treating it as unset. ` +
      'Visitor addresses are not forwarded to the API, so every visitor shares the web server rate-limit bucket.'
    );
  }
  if (!env.API_URL) {
    return (
      'INTERNAL_API_SECRET is set but API_URL is not; the secret is sent only to an API named by API_URL, ' +
      'never to the NEXT_PUBLIC_API_URL fallback. Visitor addresses are not forwarded to the API.'
    );
  }
  return null;
}
