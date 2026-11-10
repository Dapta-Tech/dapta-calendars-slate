import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintOneOffLink, revokeOneOffLink, sql } from '@slate/db';
import { bootHarness, errorText, structured, type Harness } from './mcp-harness';

/**
 * The setup reads: list_schedules / get_schedule (what the Availability page
 * shows) and get_event_type / list_one_off_links (what the event-type editor
 * shows). A key acts for the account, so they read across it; the event-type
 * allowlist and the tenant boundary still hold.
 */

type Schedule = { id: string; name: string; time_zone: string; is_default: boolean; member_id: string; member_name: string | null };
type Link = { id: string; url: string; state: string; created_at: string; booking_uid: string | null; revoked_at: string | null };

let h: Harness;
let introId: string;
let teamId: string;

beforeAll(async () => {
  h = await bootHarness();
  introId = (await h.db.get<{ id: string }>(sql`SELECT id FROM event_type WHERE slug = 'intro-call' AND account_id = ${h.accountId}`))!.id;
  teamId = (await h.db.get<{ id: string }>(sql`SELECT id FROM event_type WHERE slug = 'team-demo' AND account_id = ${h.accountId}`))!.id;
});
afterAll(async () => {
  await h.close();
});

describe('list_schedules and get_schedule', () => {
  it("lists every member's reusable schedules, marking each person's default", async () => {
    const c = await h.connect(await h.key(['availability:read']));
    const got = structured<{ schedules: Schedule[]; count: number }>(await c.callTool({ name: 'list_schedules', arguments: {} }));
    const stored = await h.db.all<{ id: string }>(
      sql`SELECT id FROM schedule WHERE account_id = ${h.accountId} AND event_type_id IS NULL`,
    );
    expect(got.count).toBe(stored.length);
    expect(got.schedules.map((s) => s.id).sort()).toEqual(stored.map((s) => s.id).sort());
    const defaults = await h.db.all<{ default_schedule_id: string }>(
      sql`SELECT default_schedule_id FROM member WHERE account_id = ${h.accountId} AND default_schedule_id IS NOT NULL`,
    );
    expect(got.schedules.filter((s) => s.is_default).map((s) => s.id).sort()).toEqual(defaults.map((d) => d.default_schedule_id).sort());
    // More than one person's schedules: the key reads the account, not one member.
    expect(new Set(got.schedules.map((s) => s.member_id)).size).toBeGreaterThan(1);
  });

  it('reads one schedule as weekly rules and date rules', async () => {
    const c = await h.connect(await h.key(['availability:read']));
    const [first] = structured<{ schedules: Schedule[] }>(await c.callTool({ name: 'list_schedules', arguments: {} })).schedules;
    const got = structured<{ schedule: { id: string; time_zone: string; weekly: { days: number[]; start: string; end: string }[]; dates: unknown[] } }>(
      await c.callTool({ name: 'get_schedule', arguments: { schedule_id: first!.id } }),
    );
    expect(got.schedule.id).toBe(first!.id);
    expect(got.schedule.time_zone).toBe(first!.time_zone);
    expect(got.schedule.weekly.length).toBeGreaterThan(0);
    for (const r of got.schedule.weekly) {
      expect(r.start).toMatch(/^\d{2}:\d{2}/);
      for (const d of r.days) expect(d >= 0 && d <= 6).toBe(true);
    }
  });

  it("reports another account's schedule as not found", async () => {
    const theirs = (await h.db.get<{ id: string }>(sql`SELECT id FROM schedule WHERE account_id = ${h.other.accountId} LIMIT 1`))!.id;
    const c = await h.connect(await h.key(['availability:read']));
    expect(errorText(await c.callTool({ name: 'get_schedule', arguments: { schedule_id: theirs } }))).toContain('NOT_FOUND');
  });
});

describe('get_event_type', () => {
  it('reads one event type with its editor settings and its public link', async () => {
    const c = await h.connect(await h.key(['event-types:read']));
    const got = structured<{ event_type: Record<string, unknown> }>(await c.callTool({ name: 'get_event_type', arguments: { event_type_id: introId } }));
    const row = (await h.db.get<{ length_minutes: number; minimum_booking_notice: number; title: string }>(
      sql`SELECT length_minutes, minimum_booking_notice, title FROM event_type WHERE id = ${introId}`,
    ))!;
    expect(got.event_type).toMatchObject({
      id: introId,
      slug: 'intro-call',
      title: row.title,
      kind: 'personal',
      duration_minutes: row.length_minutes,
      minimum_notice_minutes: row.minimum_booking_notice,
      hidden: false,
    });
    expect(got.event_type['booking_page_url']).toMatch(/\/intro-call$/);
    expect(Array.isArray(got.event_type['questions'])).toBe(true);
  });

  it('reads a team event with its hosts', async () => {
    const c = await h.connect(await h.key(['event-types:read']));
    const got = structured<{ event_type: { kind: string; team_id: string | null; hosts: unknown[] } }>(
      await c.callTool({ name: 'get_event_type', arguments: { event_type_id: teamId } }),
    );
    expect(got.event_type.kind).toBe('team');
    expect(got.event_type.team_id).toBeTruthy();
  });

  it("hides an event type outside the key's allowlist, and another account's", async () => {
    const narrow = await h.connect(await h.key(['event-types:read'], { eventTypeIds: [teamId] }));
    expect(errorText(await narrow.callTool({ name: 'get_event_type', arguments: { event_type_id: introId } }))).toContain('NOT_FOUND');
    const wide = await h.connect(await h.key(['event-types:read']));
    expect(errorText(await wide.callTool({ name: 'get_event_type', arguments: { event_type_id: h.other.eventTypeId } }))).toContain('NOT_FOUND');
  });
});

describe('list_one_off_links', () => {
  it('lists the links newest first, with a full address and each state', async () => {
    const first = (await mintOneOffLink(h.db, { accountId: h.accountId, eventTypeId: introId }, Date.now() - 60_000))!;
    const second = (await mintOneOffLink(h.db, { accountId: h.accountId, eventTypeId: introId }))!;
    await revokeOneOffLink(h.db, h.accountId, introId, first.id);
    const c = await h.connect(await h.key(['event-types:read']));
    const got = structured<{ links: Link[]; count: number }>(await c.callTool({ name: 'list_one_off_links', arguments: { event_type_id: introId } }));
    const ours = got.links.filter((l) => l.id === first.id || l.id === second.id);
    expect(ours.map((l) => l.id)).toEqual([second.id, first.id]);
    expect(ours[0]).toMatchObject({ state: 'live', revoked_at: null, booking_uid: null });
    expect(ours[0]!.url).toMatch(new RegExp(`^https?://[^/]+/booking/${second.token}$`));
    expect(ours[1]!.state).toBe('revoked');
    expect(ours[1]!.revoked_at).toBeTruthy();
  });

  it("hides the links of an event type outside the allowlist, and another account's", async () => {
    const narrow = await h.connect(await h.key(['event-types:read'], { eventTypeIds: [teamId] }));
    expect(errorText(await narrow.callTool({ name: 'list_one_off_links', arguments: { event_type_id: introId } }))).toContain('NOT_FOUND');
    const wide = await h.connect(await h.key(['event-types:read']));
    expect(errorText(await wide.callTool({ name: 'list_one_off_links', arguments: { event_type_id: h.other.eventTypeId } }))).toContain('NOT_FOUND');
  });
});
