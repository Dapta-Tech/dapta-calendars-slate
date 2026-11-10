import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@slate/db';
import { bootHarness, errorText, structured, type Harness } from './mcp-harness';

/**
 * The last reads: list_event_types by team, list_connection_calendars,
 * list_integrations and list_crm_contact_properties. The harness runs with no
 * calendar provider and no CRM, so the provider-backed reads answer empty with
 * a reason rather than failing.
 */

let h: Harness;

beforeAll(async () => {
  h = await bootHarness();
});
afterAll(async () => {
  await h.close();
});

const call = async (scopes: string[], name: string, args: Record<string, unknown> = {}) =>
  (await h.connect(await h.key(scopes))).callTool({ name, arguments: args });

describe('list_event_types by team', () => {
  it("lists only that team's event types", async () => {
    const team = (await h.db.get<{ id: string }>(sql`SELECT id FROM team WHERE account_id = ${h.accountId} AND slug = 'sales'`))!;
    const got = structured<{ event_types: { slug: string; kind: string; team_slug: string | null }[] }>(
      await call(['event-types:read'], 'list_event_types', { team_id: team.id }),
    );
    expect(got.event_types.length).toBeGreaterThan(0);
    for (const e of got.event_types) expect(e).toMatchObject({ kind: 'team', team_slug: 'sales' });
    expect(got.event_types.map((e) => e.slug)).toContain('team-demo');
    const all = structured<{ event_types: { slug: string }[] }>(await call(['event-types:read'], 'list_event_types'));
    expect(all.event_types.map((e) => e.slug)).toContain('intro-call');
  });

  it('reports an unknown team as not found', async () => {
    expect(errorText(await call(['event-types:read'], 'list_event_types', { team_id: 'no-such-team' }))).toContain('NOT_FOUND');
  });
});

describe('list_connection_calendars', () => {
  it("answers empty with no provider, and reports another account's connection as not found", async () => {
    const insert = async (accountId: string) => {
      const member = (await h.db.get<{ id: string }>(sql`SELECT id FROM member WHERE account_id = ${accountId} ORDER BY created_at ASC LIMIT 1`))!;
      const id = randomUUID();
      await h.db.run(
        sql`INSERT INTO connected_calendar (id, account_id, member_id, provider, external_id, is_destination, check_conflicts, created_at)
            VALUES (${id}, ${accountId}, ${member.id}, 'google', ${`ext-${id}`}, 0, 1, ${Date.now()})`,
      );
      return id;
    };
    const ours = await insert(h.accountId);
    const theirs = await insert(h.other.accountId);
    const got = structured<{ connection_id: string; calendars: unknown[]; count: number }>(
      await call(['availability:read'], 'list_connection_calendars', { connection_id: ours }),
    );
    expect(got).toMatchObject({ connection_id: ours, calendars: [], count: 0 });
    expect(errorText(await call(['availability:read'], 'list_connection_calendars', { connection_id: theirs }))).toContain('NOT_FOUND');
  });
});

describe('list_integrations', () => {
  it('reports the integrations and what the deployment supports, never a credential', async () => {
    const raw = await call(['event-types:read'], 'list_integrations');
    const got = structured<{ integrations: unknown[]; deployment: { enabled: boolean; can_store_credentials: boolean; required_scopes: string[] } }>(raw);
    expect(Array.isArray(got.integrations)).toBe(true);
    expect(typeof got.deployment.enabled).toBe('boolean');
    expect(typeof got.deployment.can_store_credentials).toBe('boolean');
    expect(JSON.stringify(raw)).not.toMatch(/token|last4/i);
  });
});

describe('list_crm_contact_properties', () => {
  it('answers an empty list with the reason when there is no CRM', async () => {
    const got = structured<{ connected: boolean; properties: unknown[]; reason: string | null; count: number }>(
      await call(['event-types:read'], 'list_crm_contact_properties'),
    );
    expect(got).toMatchObject({ connected: false, properties: [], count: 0 });
    expect(got.reason).toBe('disabled');
  });
});
