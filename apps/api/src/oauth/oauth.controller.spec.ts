import { afterAll, describe, expect, it } from 'vitest';
import { sql } from '@slate/db';
import { bootHarness, type Harness } from '../mcp/mcp-harness';

/**
 * What is left of the OAuth HTTP surface with OAuth off: the switches the MCP
 * pages read (`GET /v1/oauth/grants`, owner or admin only) tell the truth about
 * MCP, and discovery answers 404. The external mode is covered in
 * external.integration.spec.ts.
 */

const open: Harness[] = [];
afterAll(async () => {
  for (const h of open) await h.close();
});

async function boot(env: Record<string, string> = {}): Promise<Harness> {
  const h = await bootHarness(env);
  open.push(h);
  return h;
}

/** A member of the seeded account with the given standing: the owner, or a plain member. */
async function memberOf(h: Harness, owner: boolean): Promise<string> {
  const row = await h.db.get<{ id: string }>(
    owner
      ? sql`SELECT id FROM member WHERE account_id = ${h.accountId} AND role = 'owner' LIMIT 1`
      : sql`SELECT id FROM member WHERE account_id = ${h.accountId} AND role NOT IN ('owner','admin') AND status = 'active' LIMIT 1`,
  );
  if (!row) throw new Error(`no ${owner ? 'owner' : 'plain member'} in the seeded account`);
  return row.id;
}

const switches = async (h: Harness, memberId: string) =>
  fetch(`${h.base}/v1/oauth/grants`, { headers: { 'x-slate-account': h.accountId, 'x-slate-member': memberId } });

describe('the MCP switches with OAuth off', () => {
  it('report MCP on (the default) and no external sign-in', async () => {
    const h = await boot();
    const res = await switches(h, await memberOf(h, true));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false, mcpEnabled: true, accessTokenTtlSeconds: null, grants: [] });
  });

  it('report mcpEnabled:false when the API does not serve MCP, and /mcp answers 404 to match', async () => {
    const h = await boot({ MCP_ENABLED: 'false' });
    expect(await (await switches(h, await memberOf(h, true))).json()).toEqual({
      enabled: false,
      mcpEnabled: false,
      accessTokenTtlSeconds: null,
      grants: [],
    });
    expect((await h.post({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(404);
  });

  it('are for owners and admins only, like API keys', async () => {
    const h = await boot();
    expect((await switches(h, await memberOf(h, false))).status).toBe(403);
  });

  it('discovery answers 404', async () => {
    const h = await boot();
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server'])
      expect((await fetch(`${h.base}${path}`)).status, path).toBe(404);
  });
});
