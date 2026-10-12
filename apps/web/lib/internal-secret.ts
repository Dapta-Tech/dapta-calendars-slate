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

/** The startup warning for a secret that is set but too short; null when there is nothing to say. */
export function internalApiSecretWarning(value: string | undefined = process.env.INTERNAL_API_SECRET): string | null {
  if (!value || internalApiSecret(value)) return null;
  return (
    `INTERNAL_API_SECRET is shorter than ${INTERNAL_API_SECRET_MIN_LENGTH} characters; treating it as unset. ` +
    'Visitor addresses are not forwarded to the API, so every visitor shares the web server rate-limit bucket.'
  );
}
