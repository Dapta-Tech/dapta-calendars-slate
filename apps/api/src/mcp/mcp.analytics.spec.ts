import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from '@slate/db';
import { AnalyticsEffects } from '../analytics-effects';
import { bootHarness, idem, structured, type Harness } from './mcp-harness';

/**
 * Which channel product analytics records for a booking made over the MCP. A
 * call that carries the page's own workspace credential (API key or sign-in)
 * is the `api` channel, like the REST machine API; a keyless `book_meeting`, or
 * one with another workspace's credential, stays `booking_page`, like the public
 * booking route it wraps. Replays record nothing new.
 */
const ALL = ['availability:read', 'bookings:read', 'bookings:write', 'bookings:cancel', 'event-types:read'];
const PAGE = 'https://calendar.example.test/acme/alex-rivera/intro-call';
const TEAM_PAGE = 'https://calendar.example.test/acme/team/sales/team-demo';
type Slots = { days: { slots: { start: string }[] }[] };

const created = vi.spyOn(AnalyticsEffects.prototype, 'bookingCreated');
let h: Harness;

beforeAll(async () => {
  h = await bootHarness({ MCP_WRITE_RATE_LIMIT_CAPACITY: '200', MCP_RATE_LIMIT_CAPACITY: '500' });
});
afterAll(async () => {
  await h.close();
  created.mockRestore();
});
afterEach(() => created.mockClear());

async function slot(client: Awaited<ReturnType<Harness['connect']>>, nth: number, page = PAGE) {
  const r = structured<Slots>(
    await client.callTool({ name: 'find_available_slots', arguments: { booking_page_url: page, time_zone: 'UTC' } }),
  );
  return r.days.flatMap((d) => d.slots)[nth]!.start;
}

const channels = () => created.mock.calls.map(([booking]) => booking.channel);

describe('booking analytics channel over the MCP', () => {
  it('book_meeting without a credential records booking_page', async () => {
    const c = await h.connect();
    const args = {
      booking_page_url: PAGE,
      start: await slot(c, 30),
      attendee: { name: 'Anon', email: 'anon@example.org', time_zone: 'UTC' },
      answers: { company: 'c' },
      idempotency_key: idem('chan-anon-00001'),
    };
    structured(await c.callTool({ name: 'book_meeting', arguments: args }));
    expect(channels()).toEqual(['booking_page']);
  });

  it('book_meeting with an API key records api, once, and a replay records nothing', async () => {
    const c = await h.connect(await h.key(ALL));
    const args = {
      booking_page_url: PAGE,
      start: await slot(c, 31),
      attendee: { name: 'Keyed', email: 'keyed@example.org', time_zone: 'UTC' },
      answers: { company: 'c' },
      idempotency_key: idem('chan-key-000001'),
    };
    structured(await c.callTool({ name: 'book_meeting', arguments: args }));
    structured(await c.callTool({ name: 'book_meeting', arguments: args }));
    expect(channels()).toEqual(['api']);
  });

  it('book_meeting with another workspace\'s key records booking_page', async () => {
    const c = await h.connect(await h.otherKey(ALL));
    structured(
      await c.callTool({
        name: 'book_meeting',
        arguments: {
          booking_page_url: PAGE,
          start: await slot(c, 33),
          attendee: { name: 'Foreign', email: 'foreign@example.org', time_zone: 'UTC' },
          answers: { company: 'c' },
          idempotency_key: idem('chan-foreign-01'),
        },
      }),
    );
    expect(channels()).toEqual(['booking_page']);
  });

  it('book_meeting on a team page with an API key records api', async () => {
    const c = await h.connect(await h.key(ALL));
    structured(
      await c.callTool({
        name: 'book_meeting',
        arguments: {
          booking_page_url: TEAM_PAGE,
          start: await slot(c, 5, TEAM_PAGE),
          attendee: { name: 'Team', email: 'team@example.org', time_zone: 'UTC' },
          idempotency_key: idem('chan-team-00001'),
        },
      }),
    );
    expect(channels()).toEqual(['api']);
  });

  it('create_booking records api, once, and a replay records nothing', async () => {
    const intro = (await h.db.get<{ id: string }>(sql`SELECT id FROM event_type WHERE slug = 'intro-call' AND account_id = ${h.accountId}`))!.id;
    const c = await h.connect(await h.key(ALL));
    const args = {
      event_type_id: intro,
      start: await slot(c, 32),
      attendee: { name: 'Created', email: 'created@example.org', time_zone: 'UTC' },
      answers: { company: 'c' },
      idempotency_key: idem('chan-create-001'),
    };
    structured(await c.callTool({ name: 'create_booking', arguments: args }));
    structured(await c.callTool({ name: 'create_booking', arguments: args }));
    expect(channels()).toEqual(['api']);
  });
});
