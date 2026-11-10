import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@slate/db';
import { bootHarness, errorText, structured, type Harness } from './mcp-harness';

/**
 * The Teams, Members and Notifications reads: list_teams, list_team_members,
 * list_members and list_notification_settings. Account-wide, tenant-bound.
 */

type Team = { id: string; name: string; slug: string | null; member_count: number; team_page_url: string | null };
type TeamMember = { member_id: string; team_role: string; joined: boolean; has_hours: boolean; has_calendar: boolean };
type Member = { id: string; email: string | null; role: string; status: string };
type Notification = { key: string; audience: string; enabled: boolean; customized: boolean; subject: string; body: string };

let h: Harness;

beforeAll(async () => {
  h = await bootHarness();
});
afterAll(async () => {
  await h.close();
});

const read = async (name: string, args: Record<string, unknown> = {}) =>
  (await h.connect(await h.key(['event-types:read']))).callTool({ name, arguments: args });

describe('list_teams and list_team_members', () => {
  it('lists the teams with their member counts and team page', async () => {
    const got = structured<{ teams: Team[]; count: number }>(await read('list_teams'));
    const stored = await h.db.all<{ id: string; n: number | string }>(
      sql`SELECT t.id, (SELECT COUNT(*) FROM team_membership tm WHERE tm.team_id = t.id) AS n FROM team t WHERE t.account_id = ${h.accountId}`,
    );
    expect(got.count).toBe(stored.length);
    for (const s of stored) expect(got.teams.find((t) => t.id === s.id)!.member_count).toBe(Number(s.n));
    const sales = got.teams.find((t) => t.slug === 'sales')!;
    expect(sales.team_page_url).toMatch(/\/team\/sales$/);
  });

  it("lists a team's members with whether each can be booked", async () => {
    const sales = structured<{ teams: Team[] }>(await read('list_teams')).teams.find((t) => t.slug === 'sales')!;
    const got = structured<{ team: { id: string }; members: TeamMember[]; count: number }>(await read('list_team_members', { team_id: sales.id }));
    expect(got.team.id).toBe(sales.id);
    expect(got.count).toBe(sales.member_count);
    for (const m of got.members) {
      expect(['owner', 'member']).toContain(m.team_role);
      expect(typeof m.has_hours).toBe('boolean');
    }
  });

  it("reports another account's team, or an unknown one, as not found", async () => {
    const theirs = await h.db.get<{ id: string }>(sql`SELECT id FROM team WHERE account_id = ${h.other.accountId} LIMIT 1`);
    for (const id of [theirs?.id ?? 'no-such-team', 'no-such-team'])
      expect(errorText(await read('list_team_members', { team_id: id }))).toContain('NOT_FOUND');
  });
});

describe('list_members', () => {
  it("lists the account's roster with role and status, and nobody from another account", async () => {
    const got = structured<{ members: Member[]; count: number }>(await read('list_members'));
    const stored = await h.db.all<{ id: string }>(sql`SELECT id FROM member WHERE account_id = ${h.accountId}`);
    expect(got.members.map((m) => m.id).sort()).toEqual(stored.map((s) => s.id).sort());
    expect(got.members.filter((m) => m.role === 'owner')).toHaveLength(1);
    const foreign = await h.db.all<{ id: string }>(sql`SELECT id FROM member WHERE account_id = ${h.other.accountId}`);
    for (const f of foreign) expect(got.members.map((m) => m.id)).not.toContain(f.id);
  });
});

describe('list_notification_settings', () => {
  it('lists each account-level email with the text it sends, defaults uncustomized', async () => {
    const got = structured<{ notifications: Notification[]; variables: string[]; count: number }>(await read('list_notification_settings'));
    expect(got.count).toBeGreaterThan(0);
    expect(got.variables.length).toBeGreaterThan(0);
    for (const n of got.notifications) {
      expect(n.subject.trim()).not.toBe('');
      expect(n.body.trim()).not.toBe('');
      expect(n.audience).toBe(n.key.startsWith('host_') ? 'host' : 'invitee');
      expect(n.customized).toBe(false);
    }
  });
});
