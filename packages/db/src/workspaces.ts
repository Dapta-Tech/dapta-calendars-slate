/**
 * The workspaces (accounts) one person can act in.
 *
 * The data model has always allowed a person in several accounts: `member` is
 * unique per `(account_id, external_id)`, and `inviteMember` writes an
 * `invited` row into the INVITING account. Nothing read that back, so login
 * resolved the person's own account and an invitation led nowhere. These are
 * the reads that were missing, the same ones dForms uses for its workspace
 * header and switcher, narrowed to what this app itself granted.
 *
 * Which rows count, beside the person's home member (the one the session token
 * resolved): only memberships that came from an invitation (`invited_at` set).
 * A row the auth provider created because a token named that account stays
 * reachable only through such a token: the identity service is not obliged to
 * tell this app when it removes someone, so honoring that row from another
 * account's token would outlive the removal.
 *
 * A person is matched by EITHER key, and the second one is narrow on purpose:
 *  - `external_id`, the identity provider's stable subject (the JWT `sub`), the
 *    same in every account the person belongs to;
 *  - the email the session vouches for, but only on a row that is NOT bound to
 *    any subject yet: an invitation not yet accepted (whoever signs in with the
 *    address is that member). A row already bound to a subject belongs to that
 *    subject and is never claimed by address. Invitations store the address
 *    lowercased, so the lookup is exact and uses the email index.
 *
 * `disabled` rows never count: a revoked membership must not be reachable by
 * picking it out of a menu.
 */
import { sql, type Db } from './client';
import type { AccountRole, MemberStatus } from './members';

/** Who is asking, independent of which account they are acting in. */
export interface PersonIdentity {
  externalId: string | null;
  email: string | null;
}

/** One account this person can act in. */
export interface WorkspaceMembership {
  accountId: string;
  accountCode: string;
  accountName: string;
  memberId: string;
  role: AccountRole;
  /** `invited` until they accept it. */
  status: Exclude<MemberStatus, 'disabled'>;
}

interface MembershipRow {
  account_id: string;
  code: string;
  name: string;
  member_id: string;
  role: string;
  status: string;
  /** 1 for the home member, 0 otherwise (Postgres may send a string). */
  is_home: number | string;
  /** 1 when the row matched by subject, 0 when by address. */
  by_subject: number | string;
}

/** More than any person holds; a guard against an unbounded read. */
const MAX_WORKSPACES = 200;

/**
 * The identity of an already-resolved member, or null when there is no such
 * member. `email`, when given, is the address the session itself vouches for
 * (the verified token's claim) and wins over the stored one, which may be stale;
 * `null` means the session vouches for none, so nothing is matched by address.
 */
export async function getPersonIdentity(
  db: Db,
  accountId: string,
  memberId: string,
  opts: { email?: string | null } = {},
): Promise<PersonIdentity | null> {
  const r = await db.get<{ external_id: string | null; email: string | null }>(
    sql`SELECT external_id, email FROM member WHERE id = ${memberId} AND account_id = ${accountId} LIMIT 1`,
  );
  if (!r) return null;
  const email = opts.email === undefined ? r.email : opts.email;
  return { externalId: r.external_id || null, email: email?.trim().toLowerCase() || null };
}

/**
 * The person's invitation-granted rows matched by either key, plus their home
 * member when given, optionally in one account only. Assembled branch by
 * branch rather than as `(${x} IS NULL OR ...)`: Postgres cannot type a bare
 * parameter compared to NULL.
 */
async function membershipRows(
  db: Db,
  identity: PersonIdentity,
  opts: { homeMemberId?: string; accountId?: string },
): Promise<MembershipRow[]> {
  const externalId = identity.externalId || null;
  const email = identity.email?.trim().toLowerCase() || null;
  const keys = [];
  if (externalId) keys.push(sql`m.external_id = ${externalId}`);
  if (email) keys.push(sql`(m.external_id IS NULL AND m.email = ${email})`);
  const branches = [];
  if (keys.length) branches.push(sql`((${sql.join(keys, sql` OR `)}) AND m.invited_at IS NOT NULL)`);
  if (opts.homeMemberId) branches.push(sql`m.id = ${opts.homeMemberId}`);
  if (!branches.length) return [];
  const isHome = opts.homeMemberId ? sql`CASE WHEN m.id = ${opts.homeMemberId} THEN 1 ELSE 0 END` : sql`0`;
  const bySubject = externalId ? sql`CASE WHEN m.external_id = ${externalId} THEN 1 ELSE 0 END` : sql`0`;
  const inAccount = opts.accountId ? sql`AND m.account_id = ${opts.accountId}` : sql``;
  return db.all<MembershipRow>(
    sql`SELECT a.id AS account_id, a.code, a.name, m.id AS member_id, m.role, m.status,
               ${isHome} AS is_home, ${bySubject} AS by_subject
        FROM member m JOIN account a ON a.id = m.account_id
        WHERE (${sql.join(branches, sql` OR `)}) AND m.status <> 'disabled' ${inAccount}
        ORDER BY a.created_at ASC, a.id ASC, m.created_at ASC, m.id ASC
        LIMIT ${MAX_WORKSPACES}`,
  );
}

/**
 * One membership per account. Should a person hold two rows in one account
 * (their home member, or one bound by subject, and a stray invitation to the
 * same address), the home row wins, then the bound one, then the active one.
 */
function onePerAccount(rows: MembershipRow[]): WorkspaceMembership[] {
  const best = new Map<string, MembershipRow>();
  const rank = (r: MembershipRow) =>
    (Number(r.is_home) === 1 ? 4 : 0) + (Number(r.by_subject) === 1 ? 2 : 0) + (r.status === 'active' ? 1 : 0);
  for (const r of rows) {
    const kept = best.get(r.account_id);
    if (!kept || rank(r) > rank(kept)) best.set(r.account_id, r);
  }
  return [...best.values()].map((r) => ({
    accountId: r.account_id,
    accountCode: r.code,
    accountName: r.name,
    memberId: r.member_id,
    role: (r.role as AccountRole) ?? 'member',
    status: r.status === 'invited' ? 'invited' : 'active',
  }));
}

/**
 * Every account this person can act in: their home account and every
 * invitation-granted membership (pending ones included), oldest account first.
 */
export async function listWorkspacesForIdentity(
  db: Db,
  identity: PersonIdentity,
  homeMemberId: string,
): Promise<WorkspaceMembership[]> {
  return onePerAccount(await membershipRows(db, identity, { homeMemberId }));
}

/**
 * This person's invitation-granted membership in one account (not their home:
 * the session token already speaks for that one), or null when they hold none.
 */
export async function findMembership(
  db: Db,
  identity: PersonIdentity,
  accountId: string,
): Promise<WorkspaceMembership | null> {
  return onePerAccount(await membershipRows(db, identity, { accountId }))[0] ?? null;
}

/**
 * Accept an invitation: the row turns `active` and, when it was matched by
 * address, is bound to the person's subject, so it follows the person from then
 * on (and the MCP door, which finds a person's accounts by subject, sees it).
 *
 * Deliberately narrow: ONLY `invited` to `active`. A disabled member stays
 * disabled, an active one is not rewritten. The subject is bound only while the
 * row has none and no other row of the account already carries it, which keeps
 * the per-account unique index out of reach. Returns true for the one request
 * that made the change, so the caller can report the acceptance once.
 */
export async function acceptInvitedMember(
  db: Db,
  accountId: string,
  memberId: string,
  externalId: string | null,
): Promise<boolean> {
  const row = externalId
    ? await db.get<{ id: string }>(
        sql`UPDATE member SET status = 'active',
              external_id = CASE
                WHEN external_id IS NULL AND NOT EXISTS (
                  SELECT 1 FROM member o WHERE o.account_id = ${accountId} AND o.external_id = ${externalId}
                ) THEN ${externalId}
                ELSE external_id END
            WHERE id = ${memberId} AND account_id = ${accountId} AND status = 'invited'
            RETURNING id`,
      )
    : await db.get<{ id: string }>(
        sql`UPDATE member SET status = 'active'
            WHERE id = ${memberId} AND account_id = ${accountId} AND status = 'invited'
            RETURNING id`,
      );
  return !!row;
}
