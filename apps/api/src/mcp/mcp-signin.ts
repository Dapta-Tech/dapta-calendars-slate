import { randomUUID } from 'node:crypto';
import type { Client as McpClient } from '@modelcontextprotocol/client';
import { sql } from '@slate/db';
import { decide, exchange, followDecision, publicClient, startAuthorization, type OAuthHarness } from '../oauth/oauth-harness';

/**
 * Specs for the reads that depend on WHO is signed in (a role, a member's own
 * calendar): an API key carries no member, so these connect through the real
 * OAuth flow, approved by the member named.
 */

/** Add an active member of the seeded account; returns its id. */
export async function addMember(h: OAuthHarness, role: 'owner' | 'admin' | 'member'): Promise<string> {
  const id = randomUUID();
  await h.db.run(
    sql`INSERT INTO member (id, account_id, handle, display_name, email, role, created_at)
        VALUES (${id}, ${h.accountId}, ${`m-${id.slice(0, 8)}`}, ${`Spec ${role}`}, ${`${role}-${id.slice(0, 8)}@acme.test`}, ${role}, ${Date.now()})`,
  );
  return id;
}

/** An MCP client signed in as `memberId` (the seeded owner when omitted). The member must be an owner or admin to approve. */
export async function signIn(h: OAuthHarness, memberId?: string, scope = 'event-types:read availability:read bookings:read'): Promise<McpClient> {
  const client = await publicClient(h);
  const started = await startAuthorization(h, client, { scope });
  const who = memberId ? { 'x-slate-account': h.accountId, 'x-slate-member': memberId } : h.owner;
  const res = await decide(h, started.uid, 'approve', who);
  if (res.status !== 200) throw new Error(`approve failed: ${res.status} ${await res.text()}`);
  const { redirectTo } = (await res.json()) as { redirectTo: string };
  const back = await followDecision(started, redirectTo);
  const t = await exchange(h, client, back.searchParams.get('code')!, started.pkce.verifier);
  if (t.status !== 200) throw new Error(`token exchange failed: ${t.status}`);
  return h.connect(String(t.json.access_token));
}
