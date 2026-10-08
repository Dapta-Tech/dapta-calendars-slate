import 'server-only';

/**
 * The small slice of the upstream identity service this app talks to directly.
 *
 * Everything else reaches the API with the session token and lets the API
 * resolve identity (AUTH-WEB-CONTRACT §1). Two things cannot work that way,
 * because they are about which account the token itself names:
 *
 *  - listing the accounts this login may act in, and
 *  - exchanging the current token for one that names a different account.
 *
 * Both live upstream. This module is the only place that knows they exist, and
 * it is inert without `IAM_BASE_URL` — a bare fork has no upstream and gets an
 * empty list, which switches the whole feature off rather than half-enabling it.
 */

/** One entry in the account picker. */
export interface Workspace {
  /** Upstream workspace id — the value the picker round-trips. */
  id: string;
  /** Upstream account id — what the session token will name after a switch. */
  accountId: string;
  name: string;
}

const iamBase = (): string | null => process.env.IAM_BASE_URL?.replace(/\/$/, '') ?? null;

/** How many workspaces to offer. Beyond this the picker needs search, not a longer list. */
const LIST_LIMIT = 200;

/**
 * The workspaces this login may act in, newest-irrelevant order (upstream's).
 *
 * Returns an empty list on any failure — no upstream, upstream down, token
 * rejected. The picker reads "nothing to choose from" and hides itself, which
 * is the right outcome for all three: this is an affordance, not a gate.
 */
export async function listWorkspaces(accessToken: string): Promise<Workspace[]> {
  const base = iamBase();
  if (!base) return [];

  const res = await fetch(`${base}/workspace?page=1&limit=${LIST_LIMIT}`, {
    headers: { authorization: `Bearer ${accessToken}` },
    cache: 'no-store',
  }).catch(() => null);
  if (!res?.ok) return [];

  const body = (await res.json().catch(() => null)) as { data?: unknown } | null;
  const rows = Array.isArray(body?.data) ? body.data : [];

  return rows.flatMap((row) => {
    const w = row as { id?: unknown; account_id?: unknown; name?: unknown };
    if (typeof w.id !== 'string' || typeof w.account_id !== 'string') return [];
    return [{ id: w.id, accountId: w.account_id, name: typeof w.name === 'string' ? w.name : w.id }];
  });
}

/**
 * The two claims this app reads off its own session token.
 *
 * Read without verifying the signature, and that is safe here because nothing
 * downstream of it is authorization: the API verifies this same token on every
 * request it serves, and upstream re-decides every switch. A forged token buys
 * a wrong menu and nothing else.
 */
function claims(accessToken: string): { email: string | null; accountId: string | null } {
  const payload = accessToken.split('.')[1];
  if (!payload) return { email: null, accountId: null };
  try {
    const body = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<string, unknown>;
    return {
      email: typeof body.email === 'string' ? body.email : null,
      accountId: typeof body.account_id === 'string' ? body.account_id : null,
    };
  } catch {
    return { email: null, accountId: null };
  }
}

/** The account this session currently acts in, as the token names it. */
export function currentAccountId(accessToken: string): string | null {
  return claims(accessToken).accountId;
}

/**
 * May this login be offered the account picker at all?
 *
 * Only the platform operator's own staff (`OPERATOR_EMAIL_DOMAIN`, the same var
 * the API reads to grant them `admin` on arrival). Two reasons, and the second
 * is the firm one:
 *
 *  - a customer has exactly one account and nothing to pick;
 *  - the upstream listing is not guaranteed to be scoped to the caller, so
 *    rendering it for anyone else risks naming tenants they should not see.
 *
 * This only decides what is drawn.
 */
export function mayPickAccount(accessToken: string): boolean {
  const configured = process.env.OPERATOR_EMAIL_DOMAIN?.trim().toLowerCase();
  if (!configured) return false;

  const { email } = claims(accessToken);
  if (!email) return false;

  // The leading `@` is load-bearing: without it `someone@notexample.com` ends
  // with the same characters and would pass.
  const suffix = configured.startsWith('@') ? configured : `@${configured}`;
  return email.toLowerCase().endsWith(suffix);
}

/** What a switch produces: the same session, now naming a different account. */
export interface SwitchedTokens {
  accessToken: string;
  refreshToken?: string;
}

/** Upstream refused to name this account in a token for this user. */
export class AccountSwitchDenied extends Error {
  constructor() {
    super('You do not have access to that account.');
  }
}

/**
 * Exchange the current token for one naming `accountId`.
 *
 * Upstream decides, not us: it is the only side that knows who may act where,
 * and it answers 403 when the answer is no. Nothing here second-guesses that —
 * the picker can show an account the caller turns out not to be allowed into,
 * and the refusal is the authority, not a bug in the list.
 *
 * The old session is not invalidated upstream; this mints an additional one.
 */
export async function switchAccount(accessToken: string, accountId: string): Promise<SwitchedTokens> {
  const base = iamBase();
  if (!base) throw new Error('No upstream identity service configured.');

  const res = await fetch(`${base}/auth/switch-account`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ account_id: accountId }),
    cache: 'no-store',
  }).catch(() => null);

  if (res?.status === 403) throw new AccountSwitchDenied();
  if (!res?.ok) throw new Error(`Could not switch account (HTTP ${res?.status ?? 'unreachable'}).`);

  const body = (await res.json().catch(() => null)) as { access_token?: unknown; refresh_token?: unknown } | null;
  if (typeof body?.access_token !== 'string' || !body.access_token) {
    throw new Error('Upstream returned no token for that account.');
  }

  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === 'string' ? body.refresh_token : undefined,
  };
}
