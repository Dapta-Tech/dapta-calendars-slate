/**
 * The link between a member and the person's user id at the external OAuth
 * authorization server MCP clients sign in with (`member.idp_subject`, the `sub`
 * of that server's tokens).
 *
 * The host login provider records it at web login; the MCP door reads it to
 * find the members a sign-in token may act as. Within one account a subject
 * belongs to one member (a unique index): the latest web login takes it, and
 * the member who held it before loses it in the same transaction.
 */
import { sql, type Db } from './client';

export interface IdpSubjectWrite {
  /** False when the member already carried this subject (or no longer exists). */
  written: boolean;
  /** Members of the same account the subject was taken from. */
  clearedMemberIds: string[];
}

/**
 * Record `subject` on the member, taking it from any other member of the same
 * account, as one transaction with the member row held (SQLite IMMEDIATE,
 * Postgres `FOR UPDATE`), so two parallel requests of one login write once.
 * Two members claiming one subject at the same instant: the unique index fails
 * one of them, which the caller treats like any other failed write.
 */
export async function recordMemberIdpSubject(db: Db, accountId: string, memberId: string, subject: string): Promise<IdpSubjectWrite> {
  const current = sql`SELECT idp_subject FROM member WHERE id = ${memberId} AND account_id = ${accountId} LIMIT 1`;
  const clear = sql`UPDATE member SET idp_subject = NULL
      WHERE account_id = ${accountId} AND idp_subject = ${subject} AND id <> ${memberId}
      RETURNING id`;
  const set = sql`UPDATE member SET idp_subject = ${subject} WHERE id = ${memberId} AND account_id = ${accountId}`;
  const unchanged: IdpSubjectWrite = { written: false, clearedMemberIds: [] };

  if (db.dialect === 'sqlite') {
    const native = db.sqlite!;
    return native.txn(
      () => {
        const row = native.drizzle.get<{ idp_subject: string | null }>(current);
        if (!row || row.idp_subject === subject) return unchanged;
        const cleared = native.drizzle.all<{ id: string }>(clear);
        native.drizzle.run(set);
        return { written: true, clearedMemberIds: cleared.map((r) => r.id) };
      },
      { immediate: true },
    );
  }
  return db.pg!.drizzle.transaction(async (tx) => {
    const rows = (await tx.execute(sql`${current} FOR UPDATE`)) as unknown as { idp_subject: string | null }[];
    if (!rows[0] || rows[0].idp_subject === subject) return unchanged;
    const cleared = (await tx.execute(clear)) as unknown as { id: string }[];
    await tx.execute(set);
    return { written: true, clearedMemberIds: cleared.map((r) => r.id) };
  });
}

export interface SubjectMembership {
  memberId: string;
  accountId: string;
  accountName: string;
  role: string;
  status: string;
}

/**
 * Every member carrying `subject`, at most one per account, oldest account
 * first. Role and status are returned, not filtered, so the caller applies its
 * own rule for who may act. Read on every MCP request: removing a member,
 * disabling them or taking their admin role away cuts access at once.
 */
export async function membershipsBySubject(db: Db, subject: string): Promise<SubjectMembership[]> {
  const rows = await db.all<{ member_id: string; account_id: string; account_name: string; role: string; status: string }>(
    sql`SELECT m.id AS member_id, m.account_id, a.name AS account_name, m.role, m.status
        FROM member m JOIN account a ON a.id = m.account_id
        WHERE m.idp_subject = ${subject}
        ORDER BY a.created_at ASC, a.id ASC
        LIMIT 200`,
  );
  return rows.map((r) => ({
    memberId: r.member_id,
    accountId: r.account_id,
    accountName: r.account_name,
    role: r.role,
    status: r.status,
  }));
}
