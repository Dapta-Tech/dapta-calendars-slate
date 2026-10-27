import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@slate/db';
import { bootHarness, errorText, idem, structured, type Harness } from './mcp-harness';

/**
 * The booking window through the MCP tools, against the real app: once an event
 * type says "up to 3 days ahead", the slot tools stop listing later times, and
 * every tool that books or moves a booking refuses a later time the way it
 * refuses a time that is not offered.
 */

const ALL = ['availability:read', 'bookings:read', 'bookings:write', 'bookings:cancel', 'event-types:read'];
const PAGE = 'https://calendar.example.test/acme/alex-rivera/intro-call';
const TEAM = 'https://calendar.example.test/acme/team/sales/team-demo';
/** The seed's host zone, which is the zone the window counts its days in. */
const HOST_TZ = 'America/New_York';
const WINDOW_DAYS = 3;

type Slot = { start: string; start_utc: string };
type Slots = { days: { slots: Slot[] }[] };
type Client = Awaited<ReturnType<Harness['connect']>>;

let h: Harness;
let introId: string;
let teamId: string;

/** "YYYY-MM-DD" of an instant in the host's zone. */
const hostDay = (iso: string | number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: HOST_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(iso),
  );
/** The last day the window allows: today in the host's zone, plus the window. */
function lastWindowDay(): string {
  const [y, m, d] = hostDay(Date.now()).split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + WINDOW_DAYS)).toISOString().slice(0, 10);
}

async function slots(client: Client, args: Record<string, unknown>, tool = 'find_available_slots'): Promise<Slot[]> {
  const r = structured<Slots>(
    await client.callTool({ name: tool, arguments: { time_zone: 'UTC', end: new Date(Date.now() + 14 * 86_400_000).toISOString(), ...args } }),
  );
  return r.days.flatMap((d) => d.slots);
}

/** The error code an MCP refusal leads with (`INVALID_SLOT: …`, `SLOT_TAKEN: …`). */
const code = (text: string) => text.match(/\b[A-Z][A-Z_]{3,}\b/)?.[0] ?? text;

/**
 * A start the event does not offer, inside the window: tomorrow at 03:13 in the
 * host's zone. What a refusal of THAT looks like is what a time past the window
 * must look like too.
 */
function unofferedStart(): string {
  const [y, m, d] = hostDay(Date.now()).split('-').map(Number);
  // 03:13 New York is 07:13 or 08:13 UTC; either is outside 09:00-17:00 local.
  return new Date(Date.UTC(y!, m! - 1, d! + 1, 7, 13)).toISOString();
}

const who = (name: string) => ({ name, email: `${name.toLowerCase().replace(/\W+/g, '.')}@example.org`, time_zone: 'UTC' });

/** Times offered before the window was set, past its last day: one per test, so no test books another's. */
let beyond: Slot[];
let beyondTeam: Slot[];

beforeAll(async () => {
  h = await bootHarness({ MCP_WRITE_RATE_LIMIT_CAPACITY: '400', MCP_RATE_LIMIT_CAPACITY: '800', RATE_LIMIT_CAPACITY: '800' });
  introId = (await h.db.get<{ id: string }>(sql`SELECT id FROM event_type WHERE slug = 'intro-call' AND account_id = ${h.accountId}`))!.id;
  teamId = (await h.db.get<{ id: string }>(sql`SELECT id FROM event_type WHERE slug = 'team-demo' AND account_id = ${h.accountId}`))!.id;
  // Before any window: two weeks of weekday times, so some fall past day 3.
  const anon = await h.connect();
  const last = lastWindowDay();
  beyond = (await slots(anon, { booking_page_url: PAGE })).filter((s) => hostDay(s.start_utc) > last);
  beyondTeam = (await slots(anon, { booking_page_url: TEAM }, 'find_team_slots')).filter((s) => hostDay(s.start_utc) > last);
  expect(beyond.length).toBeGreaterThanOrEqual(4);
  expect(beyondTeam.length).toBeGreaterThanOrEqual(1);
  await h.db.run(sql`UPDATE event_type SET booking_window_days = ${WINDOW_DAYS} WHERE id IN (${introId}, ${teamId})`);
});
afterAll(async () => {
  await h.close();
});

describe('the booking window, through the MCP tools', () => {
  it('find_available_slots and find_team_slots list nothing past the window, and still list the days inside it', async () => {
    const anon = await h.connect();
    const last = lastWindowDay();
    const personal = await slots(anon, { booking_page_url: PAGE });
    const team = await slots(anon, { booking_page_url: TEAM }, 'find_team_slots');
    expect(personal.length).toBeGreaterThan(0);
    expect(team.length).toBeGreaterThan(0);
    expect(personal.filter((s) => hostDay(s.start_utc) > last)).toEqual([]);
    expect(team.filter((s) => hostDay(s.start_utc) > last)).toEqual([]);
    // Signed in, by event type id: the same answer.
    const keyed = await h.connect(await h.key(ALL));
    const byId = await slots(keyed, { event_type_id: introId });
    expect(byId.filter((s) => hostDay(s.start_utc) > last)).toEqual([]);
  });

  it('book_meeting refuses a time past the window as it refuses a time not offered, and books inside it', async () => {
    const anon = await h.connect();
    const book = (start: string, key: string) =>
      anon.callTool({
        name: 'book_meeting',
        arguments: { booking_page_url: PAGE, start, attendee: who(`Window ${key}`), answers: { company: 'c' }, idempotency_key: idem(key) },
      });
    const past = errorText(await book(beyond[0]!.start, 'window-book-01'));
    const unoffered = errorText(await book(unofferedStart(), 'window-book-02'));
    expect(code(past)).toBe(code(unoffered));
    expect(await bookingsAt(beyond[0]!.start_utc)).toBe(0);
    const inside = (await slots(anon, { booking_page_url: PAGE }))[0]!;
    expect(structured<{ booking: { status: string } }>(await book(inside.start, 'window-book-03')).booking.status).toBe('accepted');
  });

  it('hold_slot refuses a time past the window as it refuses a time not offered', async () => {
    const anon = await h.connect();
    const hold = async (start: string, key: string) =>
      errorText(
        await anon.callTool({
          name: 'hold_slot',
          arguments: { booking_page_url: PAGE, start, time_zone: 'UTC', idempotency_key: idem(key) },
        }),
      );
    const past = await hold(beyond[1]!.start, 'window-hold-001');
    expect(past).toMatch(/^[A-Z_]+:/);
    expect(code(past)).toBe(code(await hold(unofferedStart(), 'window-hold-002')));
    const held = await h.db.get<{ n: number | string }>(
      sql`SELECT COUNT(*) AS n FROM slot_reservation WHERE slot_start_ms = ${new Date(beyond[1]!.start_utc).getTime()}`,
    );
    expect(Number(held!.n)).toBe(0);
  });

  it('create_booking (signed in) refuses a time past the window as it refuses a time not offered', async () => {
    const keyed = await h.connect(await h.key(ALL));
    const create = (start: string, key: string) =>
      keyed.callTool({
        name: 'create_booking',
        arguments: { event_type_id: introId, start, attendee: who(`Create ${key}`), answers: { company: 'c' }, idempotency_key: idem(key) },
      });
    const past = errorText(await create(beyond[2]!.start, 'window-create-1'));
    const unoffered = errorText(await create(unofferedStart(), 'window-create-2'));
    expect(code(past)).toBe(code(unoffered));
    expect(await bookingsAt(beyond[2]!.start_utc)).toBe(0);
  });

  it('book_team_meeting refuses a team time past the window as it refuses a time not offered', async () => {
    const anon = await h.connect();
    const book = (start: string, key: string) =>
      anon.callTool({
        name: 'book_team_meeting',
        arguments: { booking_page_url: TEAM, start, attendee: who(`Team ${key}`), idempotency_key: idem(key) },
      });
    const past = errorText(await book(beyondTeam[0]!.start, 'window-team-001'));
    const unoffered = errorText(await book(unofferedStart(), 'window-team-002'));
    expect(code(past)).toBe(code(unoffered));
    expect(await bookingsAt(beyondTeam[0]!.start_utc)).toBe(0);
  });

  it('reschedule_booking refuses to move a booking past the window as it refuses a time not offered', async () => {
    const keyed = await h.connect(await h.key(ALL));
    const inside = (await slots(keyed, { event_type_id: introId })).at(-1)!;
    const made = structured<{ booking: { uid: string } }>(
      await keyed.callTool({
        name: 'create_booking',
        arguments: { event_type_id: introId, start: inside.start, attendee: who('Mover'), answers: { company: 'c' }, idempotency_key: idem('window-move-001') },
      }),
    );
    const move = async (start: string, key: string) =>
      errorText(
        await keyed.callTool({ name: 'reschedule_booking', arguments: { booking_uid: made.booking.uid, start, idempotency_key: idem(key) } }),
      );
    expect(code(await move(beyond[3]!.start, 'window-move-002'))).toBe(code(await move(unofferedStart(), 'window-move-003')));
    const still = await h.db.get<{ start_ms: number | string }>(sql`SELECT start_ms FROM booking WHERE uid = ${made.booking.uid}`);
    expect(new Date(Number(still!.start_ms)).toISOString()).toBe(inside.start_utc);
  });
});

async function bookingsAt(startUtc: string): Promise<number> {
  const r = await h.db.get<{ n: number | string }>(
    sql`SELECT COUNT(*) AS n FROM booking WHERE start_ms = ${new Date(startUtc).getTime()} AND status IN ('accepted', 'pending')`,
  );
  return Number(r!.n);
}
