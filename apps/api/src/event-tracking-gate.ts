import type { ServerEnv } from '@slate/config/env';

/**
 * Whether a workspace may load the tags that can run its own code on its
 * booking pages, Google Tag Manager, Google Analytics and HubSpot
 * (`EVENT_TRACKING_HOST_SCRIPT_KEYS`, `EVENT_TRACKING_ACCOUNTS`). They would run
 * on this deployment's origin, where the dashboard and its session cookie live
 * too: a GTM container with a custom HTML tag could act as any signed-in person
 * who opens the page. So they are off unless the operator names the workspace,
 * or writes `*` for a deployment whose every workspace is trusted. Meta Pixel
 * and PostHog load only vendor code and need no permission.
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
