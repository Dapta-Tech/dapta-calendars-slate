import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintOneOffLink, sql } from '@slate/db';
import { errorText, structured } from './mcp-harness';
import { addMember, signIn } from './mcp-signin';
import { bootOAuth, type OAuthHarness } from '../oauth/oauth-harness';

/**
 * The read tools hold the same line as the dashboard route each mirrors: what
 * the dashboard keeps to owners and admins (roster, notification emails, CRM
 * status), to an event type's owner (live single-use link tokens) or to a
 * member's own calendars is not reachable with a narrow API key, nor by a
 * member who no longer holds the role. An API key has no member role, so it is
 * refused, never treated as the owner.
 */

let h: OAuthHarness;
let introId: string;

beforeAll(async () => {
  h = await bootOAuth();
  introId = (await h.db.get<{ id: string }>(sql`SELECT id FROM event_type WHERE slug = 'intro-call' AND account_id = ${h.accountId}`))!.id;
});
afterAll(async () => {
  await h.close();
});

const keyCall = async (scopes: string[], name: string, args: Record<string, unknown> = {}) =>
  (await h.connect(await h.key(scopes))).callTool({ name, arguments: args });

async function connection(memberId: string, email: string): Promise<string> {
  const id = randomUUID();
  await h.db.run(
    sql`INSERT INTO connected_calendar (id, account_id, member_id, provider, external_id, primary_email, is_destination, check_conflicts, created_at)
        VALUES (${id}, ${h.accountId}, ${memberId}, 'google', ${`ext-${id}`}, ${email}, 0, 1, ${Date.now()})`,
  );
  return id;
}

describe.each(['list_members', 'list_notification_settings', 'list_integrations'])('%s', (name) => {
  it('refuses an API key, whatever its scopes', async () => {
    const raw = await keyCall(['event-types:read', 'availability:read', 'bookings:read', 'bookings:write'], name);
    expect(errorText(raw)).toContain('FORBIDDEN');
  });

  it('answers an owner or admin sign-in, and refuses the same sign-in once the member is no longer an admin', async () => {
    const adminId = await addMember(h, 'admin');
    const c = await signIn(h, adminId);
    const got = structured<Record<string, unknown>>(await c.callTool({ name, arguments: {} }));
    expect(got).toBeTruthy();
    await h.db.run(sql`UPDATE member SET role = 'member' WHERE id = ${adminId}`);
    expect(errorText(await c.callTool({ name, arguments: {} }))).toContain('FORBIDDEN');
  });

  it('refuses a sign-in whose member was disabled', async () => {
    const adminId = await addMember(h, 'admin');
    const c = await signIn(h, adminId);
    await h.db.run(sql`UPDATE member SET status = 'disabled' WHERE id = ${adminId}`);
    expect(errorText(await c.callTool({ name, arguments: {} }))).toContain('FORBIDDEN');
  });
});

describe('list_one_off_links', () => {
  it('never hands a link token to an API key', async () => {
    const link = (await mintOneOffLink(h.db, { accountId: h.accountId, eventTypeId: introId }))!;
    const raw = await keyCall(['event-types:read'], 'list_one_off_links', { event_type_id: introId });
    const text = errorText(raw);
    expect(text).toContain('FORBIDDEN');
    expect(JSON.stringify(raw)).not.toContain(link.token);
  });

  it("shows the links to an admin sign-in, and to a member only for an event type they own", async () => {
    const link = (await mintOneOffLink(h.db, { accountId: h.accountId, eventTypeId: introId }))!;
    const memberId = await addMember(h, 'admin');
    const c = await signIn(h, memberId);
    const asAdmin = structured<{ links: { id: string; url: string }[] }>(await c.callTool({ name: 'list_one_off_links', arguments: { event_type_id: introId } }));
    expect(asAdmin.links.find((l) => l.id === link.id)!.url).toContain(link.token);

    await h.db.run(sql`UPDATE member SET role = 'member' WHERE id = ${memberId}`);
    expect(errorText(await c.callTool({ name: 'list_one_off_links', arguments: { event_type_id: introId } }))).toContain('FORBIDDEN');

    await h.db.run(sql`UPDATE event_type SET member_id = ${memberId} WHERE id = ${introId}`);
    const owned = structured<{ links: { id: string }[] }>(await c.callTool({ name: 'list_one_off_links', arguments: { event_type_id: introId } }));
    expect(owned.links.map((l) => l.id)).toContain(link.id);
  });
});

describe('calendar connections', () => {
  it("shows a sign-in only its own member's connections and calendars", async () => {
    const ownerId = (await h.db.get<{ id: string }>(sql`SELECT id FROM member WHERE account_id = ${h.accountId} AND role = 'owner' ORDER BY created_at LIMIT 1`))!.id;
    const adminId = await addMember(h, 'admin');
    const mine = await connection(adminId, 'mine@example.org');
    const theirs = await connection(ownerId, 'theirs@example.org');
    const c = await signIn(h, adminId);

    const raw = await c.callTool({ name: 'list_calendar_connections', arguments: {} });
    const ids = structured<{ connections: { id: string }[] }>(raw).connections.map((x) => x.id);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(theirs);
    expect(JSON.stringify(raw)).not.toContain('theirs@example.org');

    expect(structured<{ count: number }>(await c.callTool({ name: 'list_connection_calendars', arguments: { connection_id: mine } })).count).toBe(0);
    expect(errorText(await c.callTool({ name: 'list_connection_calendars', arguments: { connection_id: theirs } }))).toContain('NOT_FOUND');
  });

  it('refuses a sign-in whose member was disabled or removed since connecting', async () => {
    const memberId = await addMember(h, 'admin');
    const c = await signIn(h, memberId);
    const id = await connection(memberId, 'gone@example.org');
    expect(structured<{ count: number }>(await c.callTool({ name: 'list_calendar_connections', arguments: {} })).count).toBe(1);
    await h.db.run(sql`UPDATE member SET status = 'disabled' WHERE id = ${memberId}`);
    for (const [name, args] of [
      ['list_calendar_connections', {}],
      ['list_connection_calendars', { connection_id: id }],
    ] as const)
      expect(errorText(await c.callTool({ name, arguments: args }))).toContain('FORBIDDEN');
  });

  it('holds an API key to the bar of check_availability and the workspace owner\'s connections', async () => {
    const ownerId = (await h.db.get<{ id: string }>(sql`SELECT id FROM member WHERE account_id = ${h.accountId} AND role = 'owner' AND status = 'active' ORDER BY created_at LIMIT 1`))!.id;
    const coworkerId = await addMember(h, 'member');
    const owners = await connection(ownerId, 'owner-cal@example.org');
    const coworkers = await connection(coworkerId, 'coworker-cal@example.org');

    for (const name of ['list_calendar_connections', 'list_connection_calendars'])
      expect(errorText(await keyCall(['availability:read'], name, { connection_id: owners }))).toContain('bookings:write');
    expect(errorText(await (await h.connect(await h.key(['availability:read', 'bookings:write'], { eventTypeIds: [introId] }))).callTool({ name: 'list_calendar_connections', arguments: {} }))).toContain('INSUFFICIENT_SCOPE');

    const keyed = await h.connect(await h.key(['availability:read', 'bookings:write']));
    const raw = await keyed.callTool({ name: 'list_calendar_connections', arguments: {} });
    const ids = structured<{ connections: { id: string }[] }>(raw).connections.map((x) => x.id);
    expect(ids).toContain(owners);
    expect(ids).not.toContain(coworkers);
    expect(JSON.stringify(raw)).not.toContain('coworker-cal@example.org');
    expect(errorText(await keyed.callTool({ name: 'list_connection_calendars', arguments: { connection_id: coworkers } }))).toContain('NOT_FOUND');
  });
});

describe('create_event', () => {
  const args = (label: string) => {
    const d = new Date(Date.now() + 21 * 86_400_000);
    d.setUTCDate(d.getUTCDate() + ((7 - d.getUTCDay()) % 7));
    d.setUTCHours(8, 0, 0, 0);
    return { title: 'Focus', start: d.toISOString(), duration_minutes: 60, time_zone: 'UTC', idempotency_key: label };
  };

  it('creates for an active member, and refuses a member disabled since connecting', async () => {
    const memberId = await addMember(h, 'admin');
    const c = await signIn(h, memberId, 'event-types:read availability:read bookings:read bookings:write');
    const made = structured<{ event: { uid: string } }>(await c.callTool({ name: 'create_event', arguments: args('guard-event-0001') }));
    expect(made.event.uid).toBeTruthy();
    await h.db.run(sql`UPDATE member SET status = 'disabled' WHERE id = ${memberId}`);
    expect(errorText(await c.callTool({ name: 'create_event', arguments: args('guard-event-0002') }))).toContain('FORBIDDEN');
  });
});

describe('cross-member schedule and event-type reads follow the member\'s current role', () => {
  it('lets an admin read coworkers\' schedules and event types, and a demoted admin only their own', async () => {
    const adminId = await addMember(h, 'admin');
    const c = await signIn(h, adminId);
    const mine = (await h.db.get<{ id: string }>(sql`SELECT id FROM schedule WHERE member_id = ${adminId} LIMIT 1`))?.id ?? null;
    const theirs = (await h.db.get<{ id: string; member_id: string }>(
      sql`SELECT id, member_id FROM schedule WHERE account_id = ${h.accountId} AND event_type_id IS NULL AND member_id <> ${adminId} LIMIT 1`,
    ))!;

    // Current admin: everything.
    const all = structured<{ schedules: { id: string; member_id: string }[] }>(await c.callTool({ name: 'list_schedules', arguments: {} }));
    expect(all.schedules.some((s) => s.member_id !== adminId)).toBe(true);
    expect(structured<{ schedule: { id: string } }>(await c.callTool({ name: 'get_schedule', arguments: { schedule_id: theirs.id } })).schedule.id).toBe(theirs.id);
    expect(structured<{ event_type: { id: string } }>(await c.callTool({ name: 'get_event_type', arguments: { event_type_id: introId } })).event_type.id).toBe(introId);

    expect(structured<{ event_types: { id: string }[] }>(await c.callTool({ name: 'list_event_types', arguments: {} })).event_types.map((e) => e.id)).toContain(introId);

    // Demoted after connecting: the token still says admin, the member row says member.
    await h.db.run(sql`UPDATE member SET role = 'member' WHERE id = ${adminId}`);
    const own = structured<{ schedules: { member_id: string }[] }>(await c.callTool({ name: 'list_schedules', arguments: {} }));
    expect(own.schedules.every((s) => s.member_id === adminId)).toBe(true);
    expect(errorText(await c.callTool({ name: 'get_schedule', arguments: { schedule_id: theirs.id } }))).toContain('FORBIDDEN');
    expect(errorText(await c.callTool({ name: 'get_event_type', arguments: { event_type_id: introId } }))).toContain('FORBIDDEN');

    const listed = structured<{ event_types: { id: string }[] }>(await c.callTool({ name: 'list_event_types', arguments: {} }));
    expect(listed.event_types.map((e) => e.id)).not.toContain(introId);

    // Their own still read.
    if (mine) expect(structured<{ schedule: { id: string } }>(await c.callTool({ name: 'get_schedule', arguments: { schedule_id: mine } })).schedule.id).toBe(mine);
    await h.db.run(sql`UPDATE event_type SET member_id = ${adminId} WHERE id = ${introId}`);
    expect(structured<{ event_type: { id: string } }>(await c.callTool({ name: 'get_event_type', arguments: { event_type_id: introId } })).event_type.id).toBe(introId);
    expect(structured<{ event_types: { id: string }[] }>(await c.callTool({ name: 'list_event_types', arguments: {} })).event_types.map((e) => e.id)).toContain(introId);
    // A hidden event type of their own is not in the bookable list (as for an admin), but get_event_type still reads it.
    await h.db.run(sql`UPDATE event_type SET hidden = 1 WHERE id = ${introId}`);
    expect(structured<{ event_types: { id: string }[] }>(await c.callTool({ name: 'list_event_types', arguments: {} })).event_types.map((e) => e.id)).not.toContain(introId);
    expect(structured<{ event_type: { hidden: boolean } }>(await c.callTool({ name: 'get_event_type', arguments: { event_type_id: introId } })).event_type.hidden).toBe(true);
    await h.db.run(sql`UPDATE event_type SET hidden = 0 WHERE id = ${introId}`);
  });
});

describe('list_schedules pages through every schedule', () => {
  it('returns more than 200 schedules across pages with a next_cursor, for a key and for a member\'s own', async () => {
    const ownerId = (await h.db.get<{ id: string }>(sql`SELECT id FROM member WHERE account_id = ${h.accountId} AND role = 'owner' ORDER BY created_at LIMIT 1`))!.id;
    const base = Date.now();
    for (let i = 0; i < 230; i += 1) {
      await h.db.run(
        sql`INSERT INTO schedule (id, account_id, member_id, name, time_zone, created_at) VALUES (${randomUUID()}, ${h.accountId}, ${ownerId}, ${`Bulk ${i}`}, 'UTC', ${base + i})`,
      );
    }
    const total = Number(
      (await h.db.get<{ n: number | string }>(sql`SELECT COUNT(*) AS n FROM schedule WHERE account_id = ${h.accountId} AND event_type_id IS NULL`))!.n,
    );
    expect(total).toBeGreaterThan(230);

    const c = await h.connect(await h.key(['availability:read']));
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: { schedules: { id: string }[]; count: number; next_cursor: string | null } = structured(
        await c.callTool({ name: 'list_schedules', arguments: cursor ? { cursor } : {} }),
      );
      expect(page.count).toBe(page.schedules.length);
      expect(page.schedules.length).toBeLessThanOrEqual(200);
      seen.push(...page.schedules.map((s) => s.id));
      cursor = page.next_cursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(pages).toBeGreaterThan(1);
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);

    expect(errorText(await c.callTool({ name: 'list_schedules', arguments: { cursor: 'not-a-cursor' } }))).toContain('INVALID_ARGUMENT');

    // A sign-in that is not an admin pages through only its own, with no truncation either.
    const memberId = await addMember(h, 'admin');
    const s = await signIn(h, memberId);
    await h.db.run(sql`UPDATE member SET role = 'member' WHERE id = ${memberId}`);
    for (let i = 0; i < 205; i += 1) {
      await h.db.run(
        sql`INSERT INTO schedule (id, account_id, member_id, name, time_zone, created_at) VALUES (${randomUUID()}, ${h.accountId}, ${memberId}, ${`Mine ${i}`}, 'UTC', ${base + 1000 + i})`,
      );
    }
    const own: string[] = [];
    let cur: string | null = null;
    let n = 0;
    do {
      const page: { schedules: { id: string; member_id: string }[]; next_cursor: string | null } = structured(
        await s.callTool({ name: 'list_schedules', arguments: cur ? { cursor: cur } : {} }),
      );
      for (const sc of page.schedules) expect(sc.member_id).toBe(memberId);
      own.push(...page.schedules.map((x) => x.id));
      cur = page.next_cursor;
      n += 1;
    } while (cur && n < 10);
    expect(own.length).toBeGreaterThanOrEqual(205);
    expect(new Set(own).size).toBe(own.length);
  });
});
