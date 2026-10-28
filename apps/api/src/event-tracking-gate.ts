import type { ServerEnv } from '@slate/config/env';

/**
 * Whether a workspace may load tracking and pixels on its booking pages
 * (`EVENT_TRACKING_ACCOUNTS`). The tags run the host's own JavaScript on this
 * deployment's origin, where the dashboard and its session cookie live too: a
 * GTM container with a custom HTML tag could act as any signed-in person who
 * opens the page. So it is off unless the operator names the workspace, or
 * writes `*` for a deployment whose every workspace is trusted.
 *
 * Matched on the account's short code or its vanity slug, case-insensitively.
 */
export function trackingAllowedFor(
  env: Pick<ServerEnv, 'EVENT_TRACKING_ACCOUNTS'> | undefined,
  account: { code: string; vanitySlug?: string | null },
): boolean {
  const list = (env?.EVENT_TRACKING_ACCOUNTS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (list.includes('*')) return true;
  const names = [account.code, account.vanitySlug].filter((n): n is string => !!n).map((n) => n.toLowerCase());
  return names.some((n) => list.includes(n));
}
