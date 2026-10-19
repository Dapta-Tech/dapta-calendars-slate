import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@slate/db';
import { bootHarness, errorText, idem, structured, type Harness } from './mcp-harness';

/**
 * The tools that go past the launch set: hold_slot (and booking with its
 * hold_id), list_pending_bookings / confirm_booking / decline_booking, and the
 * team tools find_team_slots / book_team_meeting.
 */

const ALL = ['availability:read', 'bookings:read', 'bookings:write', 'bookings:cancel', 'event-types:read'];
const PAGE = 'https://calendar.example.test/acme/alex-rivera/intro-call';
const APPROVAL = 'https://calendar.example.test/acme/jordan-lee/approval-call';
const TEAM = 'https://calendar.example.test/acme/team/sales/team-demo';

type Slot = { start: string; start_utc: string };
type Slots = { days: { slots: Slot[] }[] };
type Client = Awaited<ReturnType<Harness['connect']>>;
type Hold = { hold: { hold_id: string; expires_at: string; expires_at_utc: string; start: string; start_utc: string; time_zone: string }; replayed: boolean };
type Decision = { booking: { uid: string; status: string; start: string; start_utc: string; time_zone: string }; already_applied: boolean };

let h: Harness;
let introId: string;
let teamId: string;
let approvalId: string;

beforeAll(async () => {
  h = await bootHarness({ MCP_WRITE_RATE_LIMIT_CAPACITY: '400', MCP_RATE_LIMIT_CAPACITY: '800', RATE_LIMIT_CAPACITY: '800' });
  introId = (await h.db.get<{ id: string }>(sql`SELECT id FROM event_type WHERE slug = 'intro-call' AND account_id = ${h.accountId}`))!.id;
  teamId = (await h.db.get<{ id: string }>(sql`SELECT id FROM event_type WHERE slug = 'team-demo' AND account_id = ${h.accountId}`))!.id;
  // A one-host event whose bookings wait for the host: Jordan's approval call.
  const jordan = (await h.db.get<{ id: string; default_schedule_id: string }>(
    sql`SELECT id, default_schedule_id FROM member WHERE handle = 'jordan-lee' AND account_id = ${h.accountId}`,
  ))!;
  approvalId = randomUUID();
  await h.db.run(
    sql`INSERT INTO event_type (id, account_id, member_id, slug, title, length_minutes, schedule_id, hidden,
          minimum_booking_notice, before_event_buffer, after_event_buffer, slot_interval, requires_confirmation, created_at)
        VALUES (${approvalId}, ${h.accountId}, ${jordan.id}, 'approval-call', 'Approval Call', 30, ${jordan.default_schedule_id}, 0,
          120, 0, 0, 30, 1, ${Date.now()})`,
  );
});
afterAll(async () => {
  await h.close();
});

async function slots(client: Client, args: Record<string, unknown>, tool = 'find_available_slots'): Promise<Slot[]> {
  const r = structured<Slots>(await client.callTool({ name: tool, arguments: { time_zone: 'America/Bogota', ...args } }));
  return r.days.flatMap((d) => d.slots);
}

const who = (name: string) => ({ name, email: `${name.toLowerCase().replace(/\W+/g, '.')}@example.org`, time_zone: 'America/Bogota' });
const count = async (query: ReturnType<typeof sql>) => Number((await h.db.get<{ n: number | string }>(query))!.n);

describe('hold_slot', () => {
  it('holds a public slot for about ten minutes, hides it from everyone, and books it with the hold', async () => {
    const anon = await h.connect();
    const slot = (await slots(anon, { booking_page_url: PAGE }))[3]!;
    const held = structured<Hold>(
      await anon.callTool({ name: 'hold_slot', arguments: { booking_page_url: PAGE, start: slot.start, time_zone: 'America/Bogota', idempotency_key: idem('hold-public-0001') } }),
    );
    expect(held.hold.hold_id).toMatch(/^hold_[A-Za-z0-9_-]{24}$/);
    expect(Date.parse(held.hold.start)).toBe(Date.parse(slot.start));
    expect(held.hold.start).toMatch(/-05:00$/);
    expect(held.hold.start_utc).toBe(slot.start_utc);
    const ttl = Date.parse(held.hold.expires_at_utc) - Date.now();
    expect(ttl).toBeGreaterThan(9 * 60_000);
    expect(ttl).toBeLessThanOrEqual(10 * 60_000);
    expect(new Date(held.hold.expires_at).toISOString()).toBe(held.hold.expires_at_utc);
    // The reservation's own uid never leaves the server.
    const reservation = (await h.db.get<{ uid: string }>(sql`SELECT uid FROM slot_reservation WHERE slot_start_ms = ${Date.parse(slot.start_utc)}`))!;
    expect(JSON.stringify(held)).not.toContain(reservation.uid);

    // Nobody is offered the time, and a keyed booking at it is refused.
    expect((await slots(anon, { booking_page_url: PAGE })).map((s) => s.start_utc)).not.toContain(slot.start_utc);
    const other = await h.connect(await h.key(ALL));
    const refused = errorText(
      await other.callTool({
        name: 'create_booking',
        arguments: { event_type_id: introId, start: slot.start, attendee: who('Sneaky Other'), answers: { company: 'X' }, idempotency_key: idem('hold-steal-0001') },
      }),
    );
    expect(refused).toContain('SLOT_TAKEN');

    const args = {
      booking_page_url: PAGE,
      start: slot.start,
      attendee: who('Holder Person'),
      answers: { company: 'Initech' },
      hold_id: held.hold.hold_id,
      idempotency_key: idem('hold-book-00001'),
    };
    const booked = structured<{ booking: { uid: string; status: string }; replayed: boolean }>(await anon.callTool({ name: 'book_meeting', arguments: args }));
    expect(booked.booking.status).toBe('accepted');
    expect(await count(sql`SELECT COUNT(*) AS n FROM slot_reservation WHERE uid = ${reservation.uid}`)).toBe(0);
    const again = structured<{ booking: { uid: string }; replayed: boolean }>(await anon.callTool({ name: 'book_meeting', arguments: args }));
    expect(again).toMatchObject({ replayed: true, booking: { uid: booked.booking.uid } });
  });

  it('a hold is bound to its caller: another key, or no key, cannot book with it', async () => {
    const keyA = await h.connect(await h.key(ALL));
    const keyB = await h.connect(await h.key(ALL));
    const anon = await h.connect();
    const slot = (await slots(keyA, { event_type_id: introId }))[6]!;
    const held = structured<Hold>(
      await keyA.callTool({ name: 'hold_slot', arguments: { event_type_id: introId, start: slot.start, time_zone: 'UTC', idempotency_key: idem('hold-bound-0001') } }),
    );
    expect(held.hold.time_zone).toBe('UTC');
    expect(held.hold.start).toMatch(/\+00:00$/);
    const create = (client: Client, key: string) =>
      client.callTool({
        name: 'create_booking',
        arguments: { event_type_id: introId, start: slot.start, attendee: who('Bound Invitee'), answers: { company: 'B' }, hold_id: held.hold.hold_id, idempotency_key: idem(key) },
      });
    expect(errorText(await create(keyB, 'hold-bound-0002'))).toContain('HOLD_NOT_FOUND');
    expect(
      errorText(
        await anon.callTool({
          name: 'book_meeting',
          arguments: { booking_page_url: PAGE, start: slot.start, attendee: who('Anon Thief'), answers: { company: 'T' }, hold_id: held.hold.hold_id, idempotency_key: idem('hold-bound-0003') },
        }),
      ),
    ).toContain('HOLD_NOT_FOUND');
    const mine = structured<{ booking: { uid: string; start_utc: string } }>(await create(keyA, 'hold-bound-0004'));
    expect(mine.booking.start_utc).toBe(slot.start_utc);
    // A retry of that booking still finds it, although the hold is consumed.
    expect(structured<{ booking: { uid: string } }>(await create(keyA, 'hold-bound-0004')).booking.uid).toBe(mine.booking.uid);
  });

  it('an expired hold books nothing and says to hold again', async () => {
    const c = await h.connect(await h.key(ALL));
    const slot = (await slots(c, { event_type_id: introId }))[9]!;
    const held = structured<Hold>(
      await c.callTool({ name: 'hold_slot', arguments: { event_type_id: introId, start: slot.start, time_zone: 'UTC', idempotency_key: idem('hold-expire-0001') } }),
    );
    await h.db.run(sql`UPDATE slot_reservation SET release_at_ms = ${Date.now() - 1000} WHERE slot_start_ms = ${Date.parse(slot.start_utc)}`);
    const before = await count(sql`SELECT COUNT(*) AS n FROM booking`);
    const text = errorText(
      await c.callTool({
        name: 'create_booking',
        arguments: { event_type_id: introId, start: slot.start, attendee: who('Late Holder'), answers: { company: 'L' }, hold_id: held.hold.hold_id, idempotency_key: idem('hold-expire-0002') },
      }),
    );
    expect(text).toContain('HOLD_EXPIRED');
    expect(text).toContain('hold_slot');
    expect(await count(sql`SELECT COUNT(*) AS n FROM booking`)).toBe(before);
  });

  it('a hold for another time or event is HOLD_MISMATCH', async () => {
    const c = await h.connect(await h.key(ALL));
    const [a, b] = (await slots(c, { event_type_id: introId })).slice(12, 14);
    const held = structured<Hold>(
      await c.callTool({ name: 'hold_slot', arguments: { event_type_id: introId, start: a!.start, time_zone: 'UTC', idempotency_key: idem('hold-mismatch-01') } }),
    );
    const text = errorText(
      await c.callTool({
        name: 'create_booking',
        arguments: { event_type_id: introId, start: b!.start, attendee: who('Wrong Time'), answers: { company: 'W' }, hold_id: held.hold.hold_id, idempotency_key: idem('hold-mismatch-02') },
      }),
    );
    expect(text).toContain('HOLD_MISMATCH');
    expect(text).toContain(a!.start_utc);
    expect(errorText(await c.callTool({ name: 'book_meeting', arguments: { booking_page_url: PAGE, start: a!.start, attendee: who('Bad Id'), answers: { company: 'X' }, hold_id: 'hold_nope', idempotency_key: idem('hold-mismatch-03') } }))).toContain('HOLD_NOT_FOUND');
  });

  it('replays the same hold for the same key and refuses the key with another start', async () => {
    const c = await h.connect(await h.key(ALL));
    const [a, b] = (await slots(c, { event_type_id: introId })).slice(16, 18);
    const args = { event_type_id: introId, start: a!.start, time_zone: 'UTC', idempotency_key: idem('hold-replay-0001') };
    const first = structured<Hold>(await c.callTool({ name: 'hold_slot', arguments: args }));
    const second = structured<Hold>(await c.callTool({ name: 'hold_slot', arguments: args }));
    expect(first.replayed).toBe(false);
    expect(second).toMatchObject({ replayed: true, hold: { hold_id: first.hold.hold_id } });
    expect(await count(sql`SELECT COUNT(*) AS n FROM slot_reservation WHERE slot_start_ms = ${Date.parse(a!.start_utc)}`)).toBe(1);
    expect(errorText(await c.callTool({ name: 'hold_slot', arguments: { ...args, start: b!.start } }))).toContain('IDEMPOTENCY_KEY_REUSED');
  });

  it('refuses a team event, a time that is not offered, and a time already held', async () => {
    const anon = await h.connect();
    const team = (await slots(anon, { booking_page_url: TEAM }))[0]!;
    expect(
      errorText(await anon.callTool({ name: 'hold_slot', arguments: { booking_page_url: TEAM, start: team.start, time_zone: 'UTC', idempotency_key: idem('hold-team-00001') } })),
    ).toContain('FEATURE_NOT_SUPPORTED');
    const odd = new Date(Date.now() + 3 * 86_400_000 + 7 * 3_600_000 + 13 * 60_000).toISOString();
    expect(
      errorText(await anon.callTool({ name: 'hold_slot', arguments: { booking_page_url: PAGE, start: odd, time_zone: 'UTC', idempotency_key: idem('hold-odd-000001') } })),
    ).toContain('INVALID_SLOT');
    const c = await h.connect(await h.key(ALL));
    const slot = (await slots(c, { event_type_id: introId }))[20]!;
    structured(await c.callTool({ name: 'hold_slot', arguments: { event_type_id: introId, start: slot.start, time_zone: 'UTC', idempotency_key: idem('hold-twice-0001') } }));
    expect(
      errorText(await anon.callTool({ name: 'hold_slot', arguments: { booking_page_url: PAGE, start: slot.start, time_zone: 'UTC', idempotency_key: idem('hold-twice-0002') } })),
    ).toContain('INVALID_SLOT');
  });

  it('by event type id it needs bookings:write, honours the allowlist, and is NOT_FOUND across tenants', async () => {
    const reader = await h.connect(await h.key(['availability:read', 'bookings:read']));
    const text = errorText(await reader.callTool({ name: 'hold_slot', arguments: { event_type_id: introId, start: '2031-01-06T15:00:00Z', time_zone: 'UTC', idempotency_key: idem('hold-scope-0001') } }));
    expect(text).toContain('INSUFFICIENT_SCOPE');
    expect(text).toContain('bookings:write');
    const anon = await h.connect();
    expect(errorText(await anon.callTool({ name: 'hold_slot', arguments: { event_type_id: introId, start: '2031-01-06T15:00:00Z', time_zone: 'UTC', idempotency_key: idem('hold-scope-0002') } }))).toContain('AUTH_REQUIRED');
    const narrow = await h.connect(await h.key(ALL, { eventTypeIds: [teamId] }));
    expect(errorText(await narrow.callTool({ name: 'hold_slot', arguments: { event_type_id: introId, start: '2031-01-06T15:00:00Z', time_zone: 'UTC', idempotency_key: idem('hold-scope-0003') } }))).toContain('NOT_FOUND');
    const foreign = await h.connect(await h.otherKey(ALL));
    const cross = errorText(await foreign.callTool({ name: 'hold_slot', arguments: { event_type_id: introId, start: '2031-01-06T15:00:00Z', time_zone: 'UTC', idempotency_key: idem('hold-scope-0004') } }));
    expect(cross).toContain('NOT_FOUND');
    expect(cross).not.toMatch(/Intro|alex/i);
  });

  it('caps open holds per host like the public reservations route', async () => {
    const c = await h.connect(await h.key(ALL));
    await h.db.run(sql`DELETE FROM slot_reservation`);
    const open = (await slots(c, { event_type_id: introId })).slice(30, 41);
    for (const [i, slot] of open.slice(0, 10).entries())
      structured(await c.callTool({ name: 'hold_slot', arguments: { event_type_id: introId, start: slot.start, time_zone: 'UTC', idempotency_key: idem(`hold-cap-${i}-000`) } }));
    const text = errorText(await c.callTool({ name: 'hold_slot', arguments: { event_type_id: introId, start: open[10]!.start, time_zone: 'UTC', idempotency_key: idem('hold-cap-10-000') } }));
    expect(text).toContain('TOO_MANY_HOLDS');
    await h.db.run(sql`DELETE FROM slot_reservation`);
  });
});

/** A booking request on Jordan's approval call, waiting for the host. */
async function pendingBooking(nth: number, name: string): Promise<string> {
  const anon = await h.connect();
  const slot = (await slots(anon, { booking_page_url: APPROVAL }))[nth]!;
  const r = structured<{ booking: { uid: string; status: string } }>(
    await anon.callTool({ name: 'book_meeting', arguments: { booking_page_url: APPROVAL, start: slot.start, attendee: who(name), idempotency_key: idem(`pending-${randomUUID()}`) } }),
  );
  expect(r.booking.status).toBe('pending');
  return r.booking.uid;
}

async function waitFor(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 50 && !(await check()); i += 1) await new Promise((r) => setTimeout(r, 20));
}

describe('pending bookings', () => {
  it('lists requests with minimal fields, confirms one, and a repeated confirm changes and sends nothing', async () => {
    const uid = await pendingBooking(0, 'Penny Pending');
    const reader = await h.connect(await h.key(['bookings:read']));
    const list = structured<{ bookings: Record<string, unknown>[] }>(await reader.callTool({ name: 'list_pending_bookings', arguments: { time_zone: 'America/Bogota' } }));
    const row = list.bookings.find((b) => b['uid'] === uid)!;
    expect(row).toMatchObject({ status: 'pending', event_type_id: approvalId, invitee_email_domain: 'example.org' });
    expect(String(row['start'])).toMatch(/-05:00$/);
    expect(new Date(String(row['start'])).toISOString()).toBe(row['start_utc']);
    expect(JSON.stringify(list)).not.toMatch(/Penny|penny\./);
    expect(list.bookings.every((b) => b['status'] === 'pending')).toBe(true);

    const writer = await h.connect(await h.key(['bookings:write']));
    const args = { booking_uid: uid, time_zone: 'America/Bogota', idempotency_key: idem('confirm-key-0001') };
    const first = structured<Decision>(await writer.callTool({ name: 'confirm_booking', arguments: args }));
    expect(first).toMatchObject({ already_applied: false, booking: { uid, status: 'accepted', time_zone: 'America/Bogota' } });
    expect(first.booking.start).toMatch(/-05:00$/);
    const mails = sql`SELECT COUNT(*) AS n FROM outbox WHERE booking_uid = ${uid} AND action = 'confirmation'`;
    await waitFor(async () => (await count(mails)) > 0);
    const sent = await count(mails);
    expect(sent).toBeGreaterThan(0);

    const replay = structured<Decision>(await writer.callTool({ name: 'confirm_booking', arguments: args }));
    expect(replay).toMatchObject({ already_applied: true, booking: { uid, status: 'accepted' } });
    const fresh = structured<Decision>(await writer.callTool({ name: 'confirm_booking', arguments: { ...args, idempotency_key: idem('confirm-key-0002') } }));
    expect(fresh).toMatchObject({ already_applied: true, booking: { status: 'accepted' } });
    await new Promise((r) => setTimeout(r, 100));
    expect(await count(mails)).toBe(sent);
    expect(errorText(await writer.callTool({ name: 'confirm_booking', arguments: { ...args, booking_uid: await h.newBooking() } }))).toContain('IDEMPOTENCY_KEY_REUSED');

    const after = structured<{ bookings: { uid: string }[] }>(await reader.callTool({ name: 'list_pending_bookings', arguments: {} }));
    expect(after.bookings.map((b) => b.uid)).not.toContain(uid);
  });

  it('declines with a reason, twice without harm, and a declined request cannot be confirmed', async () => {
    const uid = await pendingBooking(2, 'Dee Declined');
    const writer = await h.connect(await h.key(['bookings:write', 'bookings:read']));
    const declined = structured<Decision>(
      await writer.callTool({ name: 'decline_booking', arguments: { booking_uid: uid, reason: 'Fully booked that week', idempotency_key: idem('decline-key-0001') } }),
    );
    expect(declined).toMatchObject({ already_applied: false, booking: { status: 'rejected', time_zone: 'America/New_York' } });
    const reason = await h.db.get<{ cancellation_reason: string }>(sql`SELECT cancellation_reason FROM booking WHERE uid = ${uid}`);
    expect(reason!.cancellation_reason).toBe('Fully booked that week');
    const again = structured<Decision>(await writer.callTool({ name: 'decline_booking', arguments: { booking_uid: uid, idempotency_key: idem('decline-key-0002') } }));
    expect(again.already_applied).toBe(true);
    const confirm = errorText(await writer.callTool({ name: 'confirm_booking', arguments: { booking_uid: uid, idempotency_key: idem('decline-key-0003') } }));
    expect(confirm).toContain('NOT_PENDING');
    expect(confirm).toContain('rejected');
  });

  it('decline cannot touch an accepted booking: cancelling keeps its own scope', async () => {
    const uid = await h.newBooking();
    const writer = await h.connect(await h.key(['bookings:write']));
    expect(errorText(await writer.callTool({ name: 'decline_booking', arguments: { booking_uid: uid, idempotency_key: idem('decline-acc-0001') } }))).toContain('NOT_PENDING');
    expect((await h.db.get<{ status: string }>(sql`SELECT status FROM booking WHERE uid = ${uid}`))!.status).toBe('accepted');
  });

  it('confirm refuses a time that filled up meanwhile and leaves the request pending', async () => {
    const uid = await pendingBooking(4, 'Fay Filled');
    const b = (await h.db.get<{ start_ms: number; end_ms: number; host_member_id: string; event_type_id: string }>(
      sql`SELECT start_ms, end_ms, host_member_id, event_type_id FROM booking WHERE uid = ${uid}`,
    ))!;
    await h.db.run(
      sql`INSERT INTO booking (id, account_id, uid, event_type_id, host_member_id, title, start_ms, end_ms, status, metadata, created_at, updated_at)
          VALUES (${randomUUID()}, ${h.accountId}, ${randomUUID()}, ${b.event_type_id}, ${b.host_member_id}, 'Clash', ${Number(b.start_ms)}, ${Number(b.end_ms)}, 'accepted', ${null}, ${Date.now()}, ${Date.now()})`,
    );
    const writer = await h.connect(await h.key(['bookings:write']));
    const text = errorText(await writer.callTool({ name: 'confirm_booking', arguments: { booking_uid: uid, idempotency_key: idem('confirm-clash-01') } }));
    expect(text).toContain('SLOT_TAKEN');
    expect(text).toContain('decline_booking');
    expect((await h.db.get<{ status: string }>(sql`SELECT status FROM booking WHERE uid = ${uid}`))!.status).toBe('pending');
  });

  it('another tenant, or a key outside the allowlist, sees no request and can decide nothing', async () => {
    const uid = await pendingBooking(6, 'Tina Tenant');
    for (const client of [await h.connect(await h.otherKey(ALL)), await h.connect(await h.key(ALL, { eventTypeIds: [introId] }))]) {
      for (const name of ['confirm_booking', 'decline_booking']) {
        const text = errorText(await client.callTool({ name, arguments: { booking_uid: uid, idempotency_key: idem(`cross-${randomUUID()}`) } }));
        expect(text).toContain('NOT_FOUND');
        expect(text).not.toMatch(/Tina|Approval/);
      }
      const list = structured<{ bookings: { uid: string }[] }>(await client.callTool({ name: 'list_pending_bookings', arguments: { limit: 50 } }));
      expect(list.bookings.map((b) => b.uid)).not.toContain(uid);
    }
    expect((await h.db.get<{ status: string }>(sql`SELECT status FROM booking WHERE uid = ${uid}`))!.status).toBe('pending');
  });

  it('each tool names the scope it needs', async () => {
    const writeOnly = await h.connect(await h.key(['bookings:write']));
    expect(errorText(await writeOnly.callTool({ name: 'list_pending_bookings', arguments: {} }))).toContain('bookings:read');
    const readOnly = await h.connect(await h.key(['bookings:read', 'bookings:cancel']));
    for (const name of ['confirm_booking', 'decline_booking']) {
      const text = errorText(await readOnly.callTool({ name, arguments: { booking_uid: 'x', idempotency_key: idem('scope-decide-01') } }));
      expect(text).toContain('INSUFFICIENT_SCOPE');
      expect(text).toContain('bookings:write');
    }
    const anon = await h.connect();
    expect(errorText(await anon.callTool({ name: 'list_pending_bookings', arguments: {} }))).toContain('AUTH_REQUIRED');
  });
});

describe('team tools', () => {
  type TeamSlots = Slots & { team: { slug: string; name: string; scheduling_type: string; host_count: number }; event_type: { kind: string; id: string }; time_zone: string };
  type TeamBooking = { booking: { uid: string; status: string; start: string; start_utc: string; time_zone: string }; assigned_hosts: string[]; team: { scheduling_type: string } };

  it('finds team slots on a team link, on the team page alone, and by id with a key', async () => {
    const anon = await h.connect();
    const byLink = structured<TeamSlots>(await anon.callTool({ name: 'find_team_slots', arguments: { booking_page_url: TEAM, time_zone: 'America/Bogota' } }));
    expect(byLink.team).toEqual({ slug: 'sales', name: 'Sales', scheduling_type: 'round_robin', host_count: 2 });
    expect(byLink.event_type.kind).toBe('team');
    const first = byLink.days[0]!.slots[0]!;
    expect(first.start).toMatch(/-05:00$/);
    expect(new Date(first.start).toISOString()).toBe(first.start_utc);
    // The team page offers one event, so the page alone is enough.
    const byPage = structured<TeamSlots>(
      await anon.callTool({ name: 'find_team_slots', arguments: { booking_page_url: 'https://calendar.example.test/acme/team/sales', time_zone: 'America/Bogota' } }),
    );
    expect(byPage.event_type.id).toBe(teamId);
    const keyed = await h.connect(await h.key(['availability:read']));
    const byId = structured<TeamSlots>(await keyed.callTool({ name: 'find_team_slots', arguments: { event_type_id: teamId, time_zone: 'UTC' } }));
    expect(byId.days.length).toBeGreaterThan(0);
  });

  it('refuses a personal event and a personal link, and is NOT_FOUND across tenants and outside the allowlist', async () => {
    const keyed = await h.connect(await h.key(['availability:read']));
    expect(errorText(await keyed.callTool({ name: 'find_team_slots', arguments: { event_type_id: introId, time_zone: 'UTC' } }))).toContain('not a team');
    const anon = await h.connect();
    expect(errorText(await anon.callTool({ name: 'find_team_slots', arguments: { booking_page_url: PAGE, time_zone: 'UTC' } }))).toContain('not a team booking link');
    expect(errorText(await anon.callTool({ name: 'find_team_slots', arguments: { account_code: 'acme', team_slug: 'nope', time_zone: 'UTC' } }))).toContain('NOT_FOUND');
    const foreign = await h.connect(await h.otherKey(['availability:read', 'bookings:write']));
    expect(errorText(await foreign.callTool({ name: 'find_team_slots', arguments: { event_type_id: teamId, time_zone: 'UTC' } }))).toContain('NOT_FOUND');
    const narrow = await h.connect(await h.key(['availability:read'], { eventTypeIds: [introId] }));
    expect(errorText(await narrow.callTool({ name: 'find_team_slots', arguments: { event_type_id: teamId, time_zone: 'UTC' } }))).toContain('NOT_FOUND');
  });

  it('round-robin picks a free host and respects each host\'s busy time', async () => {
    const anon = await h.connect();
    const open = (await slots(anon, { booking_page_url: TEAM }, 'find_team_slots')).slice(40);
    const ids = Object.fromEntries(
      (await h.db.all<{ id: string; handle: string }>(sql`SELECT id, handle FROM member WHERE account_id = ${h.accountId}`)).map((m) => [m.handle, m.id]),
    );
    const busy = async (handle: string, slot: Slot) => {
      const start = Date.parse(slot.start_utc);
      await h.db.run(
        sql`INSERT INTO booking (id, account_id, uid, event_type_id, host_member_id, title, start_ms, end_ms, status, metadata, created_at, updated_at)
            VALUES (${randomUUID()}, ${h.accountId}, ${randomUUID()}, ${introId}, ${ids[handle]!}, 'Busy', ${start}, ${start + 1_800_000}, 'accepted', ${null}, ${Date.now()}, ${Date.now()})`,
      );
    };
    const book = (slot: Slot, name: string) =>
      anon.callTool({ name: 'book_team_meeting', arguments: { booking_page_url: TEAM, start: slot.start, attendee: who(name), idempotency_key: idem(`team-rr-${randomUUID()}`) } });

    await busy('alex-rivera', open[0]!);
    const toJordan = structured<TeamBooking>(await book(open[0]!, 'Rita Robin'));
    expect(toJordan.assigned_hosts).toEqual(['Jordan Lee']);
    expect(toJordan.team.scheduling_type).toBe('round_robin');
    expect(toJordan.booking.start).toMatch(/-05:00$/);
    expect(toJordan.booking.start_utc).toBe(open[0]!.start_utc);
    // Both hosts are now busy at that time.
    expect(errorText(await book(open[0]!, 'Sam Second'))).toContain('SLOT_TAKEN');

    await busy('jordan-lee', open[2]!);
    expect(structured<TeamBooking>(await book(open[2]!, 'Rob Robin')).assigned_hosts).toEqual(['Alex Rivera']);
  });

  it('by event type id it needs bookings:write, refuses a personal event, honours the allowlist and replays a retry', async () => {
    const c = await h.connect(await h.key(ALL));
    const slot = (await slots(c, { event_type_id: teamId }, 'find_team_slots'))[50]!;
    const args = { event_type_id: teamId, start: slot.start, attendee: who('Kay Keyed'), idempotency_key: idem('team-key-000001') };
    const first = structured<TeamBooking>(await c.callTool({ name: 'book_team_meeting', arguments: args }));
    expect(first.assigned_hosts).toHaveLength(1);
    expect(first.booking.time_zone).toBe('America/Bogota');
    const again = structured<TeamBooking>(await c.callTool({ name: 'book_team_meeting', arguments: args }));
    expect(again.booking.uid).toBe(first.booking.uid);
    expect(await count(sql`SELECT COUNT(*) AS n FROM booking WHERE uid = ${first.booking.uid}`)).toBe(1);

    expect(errorText(await c.callTool({ name: 'book_team_meeting', arguments: { ...args, event_type_id: introId, idempotency_key: idem('team-key-000002') } }))).toContain('not a team');
    const reader = await h.connect(await h.key(['availability:read', 'bookings:read']));
    expect(errorText(await reader.callTool({ name: 'book_team_meeting', arguments: { ...args, idempotency_key: idem('team-key-000003') } }))).toContain('bookings:write');
    const narrow = await h.connect(await h.key(ALL, { eventTypeIds: [introId] }));
    expect(errorText(await narrow.callTool({ name: 'book_team_meeting', arguments: { ...args, idempotency_key: idem('team-key-000004') } }))).toContain('NOT_FOUND');
    const foreign = await h.connect(await h.otherKey(ALL));
    expect(errorText(await foreign.callTool({ name: 'book_team_meeting', arguments: { ...args, idempotency_key: idem('team-key-000005') } }))).toContain('NOT_FOUND');
  });
});

describe('audit for the new tools', () => {
  it('writes a line per call without the hold id, names or emails', async () => {
    h.audit.length = 0;
    const c = await h.connect(await h.key(ALL));
    const slot = (await slots(c, { event_type_id: introId }))[24]!;
    const held = structured<Hold>(await c.callTool({ name: 'hold_slot', arguments: { event_type_id: introId, start: slot.start, time_zone: 'UTC', idempotency_key: idem('audit-hold-0001') } }));
    await c.callTool({ name: 'list_pending_bookings', arguments: {} });
    const lines = h.audit.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => l['tool'])).toEqual(expect.arrayContaining(['find_available_slots', 'hold_slot', 'list_pending_bookings']));
    expect(h.audit.join('\n')).not.toContain(held.hold.hold_id);
  });
});
