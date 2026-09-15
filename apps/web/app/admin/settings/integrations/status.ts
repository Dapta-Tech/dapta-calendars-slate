/**
 * Everything this tab DECIDES, as pure functions over the two things the API
 * hands it: the account's status row and the deployment's capabilities.
 *
 * It is a separate module because `apps/web`'s vitest runs in a NODE
 * environment with no DOM — a React component here is untestable, but a
 * function is not. Every branch the card and the dialog can take is decided
 * below and asserted in `status.spec.ts`, so the component stays a renderer.
 *
 * The two axes are deliberately ORTHOGONAL. What the account has done (a row,
 * or none) and what the deployment can do (an adapter, a key) are independent:
 * an operator can switch `CRM_PROVIDER` off under a connected account, and
 * saying only "not enabled" there would hide a credential that is really
 * stored. So the card renders both.
 */
import type { IntegrationCapabilities, IntegrationStatusView } from '@slate/types';

/** What the ACCOUNT has: derived from the row, or its absence. */
export type ConnectionState = 'none' | 'connected' | 'unhealthy' | 'disconnected';

/**
 * What the DEPLOYMENT can do. Only `ok` permits a connect attempt.
 *
 * `unknown` is separate from `disabled` on purpose. Both withhold the button,
 * but only one of them may say WHY: telling a host to go set `CRM_PROVIDER`
 * because a probe timed out is a confident, wrong and unactionable
 * instruction — and the likeliest way to reach it is a web build that shipped
 * ahead of its API, where the capabilities route 404s on a perfectly
 * well-configured deployment.
 */
export type Availability = 'ok' | 'disabled' | 'no-key' | 'unknown';

/**
 * Why an integration is unhealthy, in the order the host can act on.
 *
 * `scopes` is the case #74 made renderable: the provider returns a scope NAME
 * list, so the card can say which checkbox was missed instead of "something
 * went wrong". It outranks the message because the message is the same prose
 * for every missing scope.
 */
export type UnhealthyReason =
  | { kind: 'scopes'; scopes: string[] }
  | { kind: 'message'; message: string }
  | { kind: 'unknown' };

/** Why a connect attempt failed, mapped off the API's error CODE, not its prose. */
export type ConnectFailure =
  | { kind: 'scopes'; scopes: string[] }
  | { kind: 'rejected' }
  | { kind: 'unverified' }
  | { kind: 'no-key' }
  | { kind: 'disabled' }
  | { kind: 'generic' };

/** The row for one provider, or undefined when the account has never connected. */
export function rowFor(
  rows: IntegrationStatusView[],
  provider: string,
): IntegrationStatusView | undefined {
  return rows.find((r) => r.provider === provider);
}

export function connectionState(row: IntegrationStatusView | undefined): ConnectionState {
  // No row at all is NOT the same as a disconnected row: the second one keeps a
  // label and a last4, and its id is what stops a reconnect from duplicating
  // meetings (#63). The card has to be able to tell them apart.
  if (!row) return 'none';
  return row.status;
}

export function availability(
  caps: IntegrationCapabilities | null,
  provider?: string,
): Availability {
  // A capabilities read we could not make fails CLOSED — it withholds the
  // button — but it says so as "we could not check", never as a diagnosis of a
  // deployment we did not manage to ask.
  if (!caps) return 'unknown';
  if (!caps.enabled) return 'disabled';
  // The deployment may have an adapter that is not THIS card's. Connecting
  // would answer CRM_DISABLED, which is exactly what this route exists to stop
  // the UI from walking into.
  if (provider !== undefined && caps.provider !== provider) return 'disabled';
  return caps.canStoreCredentials ? 'ok' : 'no-key';
}

/** Connecting is offered ONLY where it can actually succeed. */
export function canConnect(caps: IntegrationCapabilities | null, provider?: string): boolean {
  return availability(caps, provider) === 'ok';
}

/**
 * The checklist for a provider, straight from the adapter (`requiredScopes` on
 * the capabilities reply). Never from the locale catalog: these are provider
 * identifiers the host matches character-for-character in someone else's UI.
 */
export function scopeChecklist(
  caps: IntegrationCapabilities | null,
  provider: string,
): string[] {
  if (!caps || caps.provider !== provider) return [];
  return caps.requiredScopes.filter((s) => typeof s === 'string' && s.trim().length > 0);
}

/**
 * Disconnecting stays available whatever the deployment can do. It needs
 * neither an adapter nor an encryption key — it scrubs a column — and an
 * account that has stored a credential must always be able to unplug it, even
 * on a deployment whose CRM was switched off afterwards.
 */
export function canDisconnect(row: IntegrationStatusView | undefined): boolean {
  return connectionState(row) === 'connected' || connectionState(row) === 'unhealthy';
}

export function unhealthyReason(row: IntegrationStatusView | undefined): UnhealthyReason {
  const scopes = row?.lastErrorDetail?.requiredGranularScopes;
  if (Array.isArray(scopes) && scopes.length > 0) return { kind: 'scopes', scopes };
  const message = row?.lastCheckDetail?.trim();
  if (message) return { kind: 'message', message };
  return { kind: 'unknown' };
}

/**
 * Pull the scope NAME list out of an arbitrary error body.
 *
 * Deliberately defensive: `ApiError.details` is whatever the server sent, and
 * this reads it without trusting its shape. Non-string entries are dropped
 * rather than coerced — a rendered `[object Object]` next to real scope names
 * would be worse than one fewer line.
 */
export function scopesFromDetails(details: Record<string, unknown> | undefined): string[] {
  const raw = details?.['requiredGranularScopes'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((s): s is string => typeof s === 'string' && s.trim().length > 0);
}

export function connectFailure(
  code: string | undefined,
  details: Record<string, unknown> | undefined,
): ConnectFailure {
  const scopes = scopesFromDetails(details);
  if (code === 'INTEGRATION_REJECTED') {
    // The scope list is what makes this reply actionable, so it wins whenever
    // the provider bothered to send one.
    return scopes.length > 0 ? { kind: 'scopes', scopes } : { kind: 'rejected' };
  }
  if (code === 'INTEGRATION_UNVERIFIED') return { kind: 'unverified' };
  if (code === 'INTEGRATION_KEY_MISSING') return { kind: 'no-key' };
  if (code === 'CRM_DISABLED') return { kind: 'disabled' };
  return { kind: 'generic' };
}
